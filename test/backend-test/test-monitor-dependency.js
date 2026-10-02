const { describe, test, beforeEach } = require("node:test");
const assert = require("node:assert");
const { MonitorDependency } = require("../../server/monitor-dependency");
const { UP, DOWN, PENDING, MAINTENANCE } = require("../../src/util");

/**
 * Create a MonitorDependency with a fake clock and manual timers
 * @param {Array<[number, number]>} edges List of [monitorID, dependsOnID]
 * @returns {{deps: MonitorDependency, clock: {now: number}, timers: Map<number, Function>, runTimers: Function, sent: Array}} Test context
 */
function setup(edges) {
    const deps = new MonitorDependency();
    const clock = { now: 1_000_000 };
    const timers = new Map();
    let timerID = 0;

    deps.now = () => clock.now;
    deps.setTimer = (fn) => {
        timers.set(++timerID, fn);
        return timerID;
    };
    deps.clearTimer = (id) => timers.delete(id);
    deps.names = new Map([
        [1, "isp"],
        [2, "inets"],
        [3, "router"],
        [4, "hhesnet.com"],
        [5, "backup-link"],
        [6, "app"],
    ]);
    deps.setGraph(edges);

    const sent = [];
    const runTimers = async () => {
        const pending = [...timers.entries()];
        timers.clear();
        for (const [, fn] of pending) {
            await fn();
        }
    };

    const sender = (id) => async (note) => sent.push({ id, note });

    return { deps, clock, timers, runTimers, sent, sender };
}

describe("MonitorDependency graph", () => {
    test("getAncestors() follows multi-level chains", () => {
        const { deps } = setup([
            [2, 1],
            [3, 2],
            [4, 3],
        ]);
        assert.deepStrictEqual(deps.getAncestors(4).sort(), [1, 2, 3]);
        assert.deepStrictEqual(deps.getAncestors(1), []);
    });

    test("getDescendants() follows multiple parents", () => {
        const { deps } = setup([
            [6, 2],
            [6, 5],
            [4, 2],
        ]);
        assert.deepStrictEqual(deps.getDescendants(2).sort(), [4, 6]);
        assert.deepStrictEqual(deps.getDescendants(5), [6]);
    });

    test("walk is safe against cycles", () => {
        const { deps } = setup([
            [1, 2],
            [2, 1],
        ]);
        assert.deepStrictEqual(deps.getAncestors(1), [2]);
    });

    test("wouldCreateCycle() detects self and descendant dependencies", () => {
        const { deps } = setup([
            [3, 2],
            [4, 3],
        ]);
        assert.strictEqual(deps.wouldCreateCycle(2, [2]), true);
        assert.strictEqual(deps.wouldCreateCycle(2, [4]), true);
        assert.strictEqual(deps.wouldCreateCycle(2, [1]), false);
        assert.strictEqual(deps.wouldCreateCycle(undefined, [4]), false);
    });
});

describe("MonitorDependency notifications", () => {
    let ctx;

    beforeEach(() => {
        // hhesnet.com -> router -> inets
        ctx = setup([
            [3, 2],
            [4, 3],
        ]);
    });

    test("monitor without dependencies sends immediately", async () => {
        await ctx.deps.recordStatus(2, DOWN);
        assert.strictEqual(ctx.deps.decide(2, DOWN, 60, ctx.sender(2)).action, "send");
    });

    test("DOWN is suppressed when a transitive dependency is DOWN", async () => {
        await ctx.deps.recordStatus(2, DOWN);
        await ctx.deps.recordStatus(4, DOWN);
        const result = ctx.deps.decide(4, DOWN, 60, ctx.sender(4));
        assert.strictEqual(result.action, "suppress");
        assert.match(result.note, /"inets"/);
    });

    test("DOWN is suppressed when a dependency is under maintenance", async () => {
        await ctx.deps.recordStatus(2, MAINTENANCE);
        assert.strictEqual(ctx.deps.decide(4, DOWN, 60, ctx.sender(4)).action, "suppress");
    });

    test("UP after a suppressed DOWN is suppressed too", async () => {
        await ctx.deps.recordStatus(2, DOWN);
        ctx.deps.decide(4, DOWN, 60, ctx.sender(4));
        await ctx.deps.recordStatus(2, UP);
        assert.strictEqual(ctx.deps.decide(4, UP, 60, ctx.sender(4)).action, "suppress");
        // Next outage behaves normally again
        assert.strictEqual(ctx.deps.decide(4, UP, 60, ctx.sender(4)).action, "send");
    });

    test("held DOWN joins the rollup when the dependency goes DOWN", async () => {
        await ctx.deps.recordStatus(2, UP);
        await ctx.deps.recordStatus(3, UP);
        assert.strictEqual(ctx.deps.decide(4, DOWN, 60, ctx.sender(4)).action, "hold");

        await ctx.deps.recordStatus(2, DOWN);
        assert.strictEqual(ctx.deps.holds.has(4), false);
        assert.strictEqual(ctx.deps.suppressed.has(4), true);
        await ctx.runTimers();
        assert.deepStrictEqual(ctx.sent, []);
    });

    test("held DOWN is sent once all dependencies were checked UP", async () => {
        await ctx.deps.recordStatus(2, UP);
        await ctx.deps.recordStatus(3, UP);
        ctx.deps.decide(4, DOWN, 60, ctx.sender(4));

        ctx.clock.now += 5000;
        await ctx.deps.recordStatus(2, UP);
        assert.deepStrictEqual(ctx.sent, [], "router not checked yet");
        await ctx.deps.recordStatus(3, UP);
        assert.strictEqual(ctx.sent.length, 1);
        assert.strictEqual(ctx.sent[0].id, 4);
        assert.match(ctx.sent[0].note, /delayed 5s/);
    });

    test("held DOWN is sent when the hold time expires", async () => {
        ctx.deps.decide(4, DOWN, 60, ctx.sender(4));
        ctx.clock.now += 60000;
        await ctx.runTimers();
        assert.strictEqual(ctx.sent.length, 1);
    });

    test("hold is extended while a dependency is PENDING", async () => {
        await ctx.deps.recordStatus(2, PENDING);
        ctx.deps.decide(4, DOWN, 60, ctx.sender(4));
        ctx.clock.now += 60000;
        await ctx.runTimers();
        assert.deepStrictEqual(ctx.sent, []);
        assert.strictEqual(ctx.deps.holds.has(4), true);

        await ctx.deps.recordStatus(2, DOWN);
        assert.strictEqual(ctx.deps.suppressed.has(4), true);
        await ctx.runTimers();
        assert.deepStrictEqual(ctx.sent, []);
    });

    test("recovery during the hold sends nothing", async () => {
        ctx.deps.decide(4, DOWN, 60, ctx.sender(4));
        assert.strictEqual(ctx.deps.decide(4, UP, 60, ctx.sender(4)).action, "suppress");
        await ctx.runTimers();
        assert.deepStrictEqual(ctx.sent, []);
    });

    test("hold of 0 seconds sends immediately", async () => {
        assert.strictEqual(ctx.deps.decide(4, DOWN, 0, ctx.sender(4)).action, "send");
    });

    test("still-down monitor is released after dependencies are stable", async () => {
        await ctx.deps.recordStatus(2, DOWN);
        ctx.deps.decide(4, DOWN, 60, ctx.sender(4));

        assert.strictEqual(await ctx.deps.checkStillDown(4, 60, ctx.sender(4)), true);
        assert.deepStrictEqual(ctx.sent, []);

        await ctx.deps.recordStatus(2, UP);
        ctx.clock.now += 30000;
        assert.strictEqual(await ctx.deps.checkStillDown(4, 60, ctx.sender(4)), true);
        assert.deepStrictEqual(ctx.sent, [], "not stable for 60s yet");

        ctx.clock.now += 30000;
        await ctx.deps.checkStillDown(4, 60, ctx.sender(4));
        assert.strictEqual(ctx.sent.length, 1);
        assert.match(ctx.sent[0].note, /Still down after "inets" recovered/);

        // Released, so normal resends and UP notification apply again
        assert.strictEqual(await ctx.deps.checkStillDown(4, 60, ctx.sender(4)), false);
        assert.strictEqual(ctx.deps.decide(4, UP, 60, ctx.sender(4)).action, "send");
    });

    test("forget() cancels holds", async () => {
        ctx.deps.decide(4, DOWN, 60, ctx.sender(4));
        ctx.deps.forget(4);
        await ctx.runTimers();
        assert.deepStrictEqual(ctx.sent, []);
    });
});

describe("MonitorDependency multiple parents", () => {
    test("suppressed if any parent is DOWN", async () => {
        const ctx = setup([
            [6, 2],
            [6, 5],
        ]);
        await ctx.deps.recordStatus(2, UP);
        await ctx.deps.recordStatus(5, DOWN);
        assert.strictEqual(ctx.deps.decide(6, DOWN, 60, ctx.sender(6)).action, "suppress");
    });
});

describe("MonitorDependency rollup", () => {
    test("DOWN lists all dependent monitors", async () => {
        const ctx = setup([
            [3, 2],
            [4, 3],
        ]);
        const rollup = ctx.deps.getRollup(2, DOWN);
        assert.strictEqual(rollup.text, 'May affect 2 dependent monitor(s): "router", "hhesnet.com"');
        assert.strictEqual(rollup.dependents.length, 2);
    });

    test("UP has no rollup text (still-down dependents alert on their own)", async () => {
        const ctx = setup([
            [3, 2],
            [4, 3],
        ]);
        await ctx.deps.recordStatus(3, UP);
        await ctx.deps.recordStatus(4, DOWN);
        const rollup = ctx.deps.getRollup(2, UP);
        assert.strictEqual(rollup.text, null);
        assert.strictEqual(rollup.dependents.length, 2);
    });

    test("no rollup without dependents", () => {
        const ctx = setup([[3, 2]]);
        assert.strictEqual(ctx.deps.getRollup(3, DOWN).text, null);
    });

    test("long lists are truncated", () => {
        const edges = [];
        for (let i = 100; i < 125; i++) {
            edges.push([i, 2]);
        }
        const ctx = setup(edges);
        assert.match(ctx.deps.getRollup(2, DOWN).text, /^May affect 25 .* \+5 more$/);
    });
});

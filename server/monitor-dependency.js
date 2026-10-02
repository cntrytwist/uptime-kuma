const { R } = require("redbean-node");
const { log, UP, DOWN, PENDING, MAINTENANCE } = require("../src/util");

/**
 * Upper bound for how long a DOWN notification may be held while waiting
 * for dependencies that keep reporting PENDING.
 */
const MAX_HOLD_MS = 30 * 60 * 1000;

/**
 * Max number of dependent monitor names listed in a rollup notification
 */
const ROLLUP_NAME_LIMIT = 20;

/**
 * Monitor dependencies ("Depends on").
 *
 * A monitor can depend on one or more other monitors. When any (direct or
 * transitive) dependency is DOWN or under maintenance, notifications of the
 * dependent monitor are suppressed and the dependency's own notification
 * lists the affected monitors instead (rollup).
 *
 * Because a dependent monitor may fail before its dependency has noticed,
 * a DOWN notification of a monitor with dependencies is held for up to
 * `dependency_hold_seconds`, until all dependencies have been checked again.
 *
 * Suppression state is kept in memory only.
 */
class MonitorDependency {
    /**
     * @type {MonitorDependency}
     */
    static instance = null;

    /**
     * Get the singleton instance
     * @returns {MonitorDependency} Instance
     */
    static getInstance() {
        if (MonitorDependency.instance === null) {
            MonitorDependency.instance = new MonitorDependency();
        }
        return MonitorDependency.instance;
    }

    /**
     * Create an empty dependency state
     */
    constructor() {
        /**
         * monitorID => Set of monitor IDs it depends on
         * @type {Map<number, Set<number>>}
         */
        this.dependsOn = new Map();

        /**
         * monitorID => Set of monitor IDs that depend on it
         * @type {Map<number, Set<number>>}
         */
        this.dependents = new Map();

        /**
         * monitorID => name
         * @type {Map<number, string>}
         */
        this.names = new Map();

        /**
         * monitorID => { status, since, checkedAt }
         * @type {Map<number, {status: number, since: number, checkedAt: number}>}
         */
        this.statuses = new Map();

        /**
         * Monitors whose DOWN notification was suppressed
         * monitorID => names of the dependencies that were down
         * @type {Map<number, string[]>}
         */
        this.suppressed = new Map();

        /**
         * Held DOWN notifications
         * monitorID => { since, holdMs, timer, send }
         * @type {Map<number, object>}
         */
        this.holds = new Map();

        this.now = () => Date.now();
        this.setTimer = (fn, ms) => setTimeout(fn, ms);
        this.clearTimer = (timer) => clearTimeout(timer);
    }

    /**
     * Load the dependency graph and monitor names from the database
     * @returns {Promise<void>}
     */
    async reload() {
        const rows = await R.getAll("SELECT monitor_id, depends_on_id FROM monitor_dependency");
        const monitors = await R.getAll("SELECT id, name FROM monitor");

        this.names = new Map(monitors.map((m) => [m.id, m.name]));
        this.setGraph(rows.map((row) => [row.monitor_id, row.depends_on_id]));
    }

    /**
     * Replace the dependency graph
     * @param {Array<[number, number]>} edges List of [monitorID, dependsOnID]
     * @returns {void}
     */
    setGraph(edges) {
        this.dependsOn = new Map();
        this.dependents = new Map();

        for (const [monitorID, dependsOnID] of edges) {
            if (!this.dependsOn.has(monitorID)) {
                this.dependsOn.set(monitorID, new Set());
            }
            this.dependsOn.get(monitorID).add(dependsOnID);

            if (!this.dependents.has(dependsOnID)) {
                this.dependents.set(dependsOnID, new Set());
            }
            this.dependents.get(dependsOnID).add(monitorID);
        }
    }

    /**
     * Breadth-first walk over a graph, safe against cycles
     * @param {Map<number, Set<number>>} graph Graph to walk
     * @param {number} startID Monitor to start from (not included)
     * @returns {number[]} Reachable monitor IDs
     */
    static walk(graph, startID) {
        const visited = new Set([startID]);
        const result = [];
        const queue = [startID];

        while (queue.length > 0) {
            const id = queue.shift();
            for (const next of graph.get(id) || []) {
                if (!visited.has(next)) {
                    visited.add(next);
                    result.push(next);
                    queue.push(next);
                }
            }
        }
        return result;
    }

    /**
     * Get all monitors this monitor depends on, directly or transitively
     * @param {number} monitorID Monitor ID
     * @returns {number[]} Monitor IDs
     */
    getAncestors(monitorID) {
        return MonitorDependency.walk(this.dependsOn, monitorID);
    }

    /**
     * Get all monitors depending on this monitor, directly or transitively
     * @param {number} monitorID Monitor ID
     * @returns {number[]} Monitor IDs
     */
    getDescendants(monitorID) {
        return MonitorDependency.walk(this.dependents, monitorID);
    }

    /**
     * Check if setting the dependencies of a monitor would create a cycle
     * @param {number} monitorID Monitor ID (may be undefined for a new monitor)
     * @param {number[]} dependsOnIDs New dependencies
     * @returns {boolean} True if a cycle would be created
     */
    wouldCreateCycle(monitorID, dependsOnIDs) {
        if (monitorID === undefined || monitorID === null) {
            return false;
        }
        if (dependsOnIDs.includes(monitorID)) {
            return true;
        }
        const descendants = new Set(this.getDescendants(monitorID));
        return dependsOnIDs.some((id) => descendants.has(id));
    }

    /**
     * Get the name of a monitor
     * @param {number} monitorID Monitor ID
     * @returns {string} Name
     */
    getName(monitorID) {
        return this.names.get(monitorID) ?? `#${monitorID}`;
    }

    /**
     * Get the ancestors that currently explain an outage of this monitor
     * (DOWN or under maintenance)
     * @param {number} monitorID Monitor ID
     * @returns {number[]} Monitor IDs
     */
    getBlockingAncestors(monitorID) {
        return this.getAncestors(monitorID).filter((id) => {
            const status = this.statuses.get(id)?.status;
            return status === DOWN || status === MAINTENANCE;
        });
    }

    /**
     * Check if any ancestor is PENDING (retrying)
     * @param {number} monitorID Monitor ID
     * @returns {boolean} True if any ancestor is pending
     */
    hasPendingAncestor(monitorID) {
        return this.getAncestors(monitorID).some((id) => this.statuses.get(id)?.status === PENDING);
    }

    /**
     * Check if all ancestors have been checked since the given time and are UP
     * @param {number} monitorID Monitor ID
     * @param {number} time Timestamp in ms
     * @returns {boolean} True if all ancestors are confirmed UP
     */
    allAncestorsConfirmedUp(monitorID, time) {
        return this.getAncestors(monitorID).every((id) => {
            const s = this.statuses.get(id);
            return s && s.status === UP && s.checkedAt > time;
        });
    }

    /**
     * Format a list of monitor names for a message
     * @param {number[]} monitorIDs Monitor IDs
     * @returns {string} Names, e.g. `"a", "b"`
     */
    formatNames(monitorIDs) {
        const names = monitorIDs.slice(0, ROLLUP_NAME_LIMIT).map((id) => `"${this.getName(id)}"`);
        if (monitorIDs.length > ROLLUP_NAME_LIMIT) {
            names.push(`+${monitorIDs.length - ROLLUP_NAME_LIMIT} more`);
        }
        return names.join(", ");
    }

    /**
     * Record the latest status of a monitor. Call on every heartbeat.
     * Held notifications of dependent monitors are re-evaluated.
     * @param {number} monitorID Monitor ID
     * @param {number} status Heartbeat status
     * @returns {Promise<void>}
     */
    async recordStatus(monitorID, status) {
        const now = this.now();
        const previous = this.statuses.get(monitorID);
        this.statuses.set(monitorID, {
            status,
            since: previous?.status === status ? previous.since : now,
            checkedAt: now,
        });

        for (const id of this.getDescendants(monitorID)) {
            if (this.holds.has(id)) {
                await this.resolveHold(id, false);
            }
        }
    }

    /**
     * Forget runtime state of a monitor, e.g. when it is paused or deleted
     * @param {number} monitorID Monitor ID
     * @returns {void}
     */
    forget(monitorID) {
        this.statuses.delete(monitorID);
        this.cancelHold(monitorID);
    }

    /**
     * Cancel a held notification
     * @param {number} monitorID Monitor ID
     * @returns {void}
     */
    cancelHold(monitorID) {
        const hold = this.holds.get(monitorID);
        if (hold) {
            this.clearTimer(hold.timer);
            this.holds.delete(monitorID);
        }
    }

    /**
     * Decide what to do with the notification of an important beat
     * (status change). For a hold, `send` is called later if the
     * notification is released.
     * @param {number} monitorID Monitor ID
     * @param {number} status Heartbeat status
     * @param {number} holdSeconds How long a DOWN notification may be held
     * @param {function(string): Promise<void>} send Sends the notification, with an optional note
     * @returns {{action: ("send"|"suppress"|"hold"), note: (string|null)}} Decision and a note for the heartbeat message
     */
    decide(monitorID, status, holdSeconds, send) {
        if (status === DOWN) {
            this.cancelHold(monitorID);

            const blocking = this.getBlockingAncestors(monitorID);
            if (blocking.length > 0) {
                this.suppressed.set(monitorID, blocking);
                return {
                    action: "suppress",
                    note: `[Alert suppressed: depends on ${this.formatNames(blocking)}, which is down]`,
                };
            }

            this.suppressed.delete(monitorID);

            const hasAncestors = (this.dependsOn.get(monitorID)?.size ?? 0) > 0;
            if (hasAncestors && holdSeconds > 0) {
                const holdMs = holdSeconds * 1000;
                this.holds.set(monitorID, {
                    since: this.now(),
                    holdMs,
                    send,
                    timer: this.setTimer(() => this.resolveHold(monitorID, true), holdMs),
                });
                return {
                    action: "hold",
                    note: `[Alert held up to ${holdSeconds}s while dependencies are checked]`,
                };
            }

            return { action: "send", note: null };
        }

        if (status === UP) {
            if (this.holds.has(monitorID)) {
                // Recovered before the DOWN notification was sent
                this.cancelHold(monitorID);
                return { action: "suppress", note: "[Alert suppressed: recovered while the down alert was held]" };
            }
            if (this.suppressed.has(monitorID)) {
                // The DOWN notification was never sent, so don't send UP either
                this.suppressed.delete(monitorID);
                return { action: "suppress", note: "[Alert suppressed: down alert was suppressed by a dependency]" };
            }
        }

        return { action: "send", note: null };
    }

    /**
     * Re-evaluate a held DOWN notification
     * @param {number} monitorID Monitor ID
     * @param {boolean} timeout Called because the hold timer expired
     * @returns {Promise<void>}
     */
    async resolveHold(monitorID, timeout) {
        const hold = this.holds.get(monitorID);
        if (!hold) {
            return;
        }

        const blocking = this.getBlockingAncestors(monitorID);
        if (blocking.length > 0) {
            this.cancelHold(monitorID);
            this.suppressed.set(monitorID, blocking);
            log.info(
                "monitor_dependency",
                `[${this.getName(monitorID)}] Held alert suppressed: depends on ${this.formatNames(blocking)}`
            );
            return;
        }

        const confirmedUp = this.allAncestorsConfirmedUp(monitorID, hold.since);
        const elapsed = this.now() - hold.since;

        if (!confirmedUp && timeout && this.hasPendingAncestor(monitorID) && elapsed < MAX_HOLD_MS) {
            // A dependency is still retrying, keep waiting
            hold.timer = this.setTimer(() => this.resolveHold(monitorID, true), hold.holdMs);
            return;
        }

        if (confirmedUp || timeout) {
            this.cancelHold(monitorID);
            log.info("monitor_dependency", `[${this.getName(monitorID)}] Releasing held alert`);
            try {
                await hold.send(`[Alert delayed ${Math.round(elapsed / 1000)}s while dependencies were checked]`);
            } catch (e) {
                log.error("monitor_dependency", e);
            }
        }
    }

    /**
     * Called on a DOWN beat that is not a status change. Sends the DOWN
     * notification of a suppressed monitor once its dependencies have been
     * back up for the hold time.
     * @param {number} monitorID Monitor ID
     * @param {number} holdSeconds Hold time in seconds
     * @param {function(string): Promise<void>} send Sends the notification, with an optional note
     * @returns {Promise<boolean>} True if the notification is (still) suppressed or held, so resends should be skipped
     */
    async checkStillDown(monitorID, holdSeconds, send) {
        if (this.holds.has(monitorID)) {
            return true;
        }

        const suppressedBy = this.suppressed.get(monitorID);
        if (!suppressedBy) {
            return false;
        }

        if (this.getBlockingAncestors(monitorID).length > 0) {
            return true;
        }

        // All dependencies are back, wait until they have been stable for the hold time
        const now = this.now();
        const stable = this.getAncestors(monitorID).every((id) => {
            const s = this.statuses.get(id);
            return !s || now - s.since >= holdSeconds * 1000;
        });
        if (!stable) {
            return true;
        }

        this.suppressed.delete(monitorID);
        log.info("monitor_dependency", `[${this.getName(monitorID)}] Still down after dependencies recovered`);
        await send(`[Still down after ${this.formatNames(suppressedBy)} recovered]`);
        return true;
    }

    /**
     * Rollup text for a notification of a monitor that others depend on
     * @param {number} monitorID Monitor ID
     * @param {number} status Heartbeat status
     * @returns {{text: (string|null), dependents: Array<{id: number, name: string, status: (number|null)}>}} Rollup
     */
    getRollup(monitorID, status) {
        const descendants = this.getDescendants(monitorID);
        const dependents = descendants.map((id) => ({
            id,
            name: this.getName(id),
            status: this.statuses.get(id)?.status ?? null,
        }));

        if (descendants.length === 0 || status !== DOWN) {
            return { text: null, dependents };
        }

        return {
            text: `May affect ${descendants.length} dependent monitor(s): ${this.formatNames(descendants)}`,
            dependents,
        };
    }

    /**
     * Get the dependencies of the given monitors
     * @param {number[]} monitorIDs Monitor IDs
     * @returns {Promise<Map<number, number[]>>} monitorID => dependency IDs
     */
    static async getDependsOnMap(monitorIDs) {
        const map = new Map();
        if (monitorIDs.length === 0) {
            return map;
        }
        const rows = await R.getAll(
            `SELECT monitor_id, depends_on_id FROM monitor_dependency WHERE monitor_id IN (${monitorIDs.map(() => "?").join(",")})`,
            monitorIDs
        );
        for (const row of rows) {
            if (!map.has(row.monitor_id)) {
                map.set(row.monitor_id, []);
            }
            map.get(row.monitor_id).push(row.depends_on_id);
        }
        return map;
    }

    /**
     * Validate the dependencies of a monitor before saving
     * @param {number|undefined} monitorID Monitor ID, undefined for a new monitor
     * @param {number} userID Owner of the monitor
     * @param {number[]|undefined} dependsOnIDs Dependency IDs, undefined to leave unchanged
     * @returns {Promise<number[]|undefined>} Normalized dependency IDs
     * @throws {Error} Invalid dependencies
     */
    async validate(monitorID, userID, dependsOnIDs) {
        if (dependsOnIDs === undefined) {
            return undefined;
        }
        if (!Array.isArray(dependsOnIDs)) {
            throw new Error("Invalid dependencies");
        }

        const ids = [...new Set(dependsOnIDs.map((id) => parseInt(id)))];
        if (ids.some((id) => isNaN(id))) {
            throw new Error("Invalid dependencies");
        }

        if (ids.length > 0) {
            const owned = await R.getCol(
                `SELECT id FROM monitor WHERE user_id = ? AND id IN (${ids.map(() => "?").join(",")})`,
                [userID, ...ids]
            );
            if (owned.length !== ids.length) {
                throw new Error("Invalid dependencies");
            }
        }

        await this.reload();
        if (this.wouldCreateCycle(monitorID, ids)) {
            throw new Error("Circular monitor dependency");
        }

        return ids;
    }

    /**
     * Save the dependencies of a monitor, validated by validate()
     * @param {number} monitorID Monitor ID
     * @param {number[]|undefined} dependsOnIDs Dependency IDs, undefined to leave unchanged
     * @returns {Promise<void>}
     */
    async save(monitorID, dependsOnIDs) {
        if (dependsOnIDs !== undefined) {
            await R.exec("DELETE FROM monitor_dependency WHERE monitor_id = ?", [monitorID]);
            for (const id of dependsOnIDs) {
                const relation = R.dispense("monitor_dependency");
                relation.monitor_id = monitorID;
                relation.depends_on_id = id;
                await R.store(relation);
            }
        }
        await this.reload();
    }
}

module.exports = {
    MonitorDependency,
};

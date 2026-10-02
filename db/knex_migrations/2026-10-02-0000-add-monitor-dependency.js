exports.up = async (knex) => {
    await knex.schema.createTable("monitor_dependency", (table) => {
        table.increments("id");
        table
            .integer("monitor_id")
            .unsigned()
            .notNullable()
            .references("id")
            .inTable("monitor")
            .onDelete("CASCADE")
            .onUpdate("CASCADE");
        table
            .integer("depends_on_id")
            .unsigned()
            .notNullable()
            .references("id")
            .inTable("monitor")
            .onDelete("CASCADE")
            .onUpdate("CASCADE");
        table.unique(["monitor_id", "depends_on_id"]);
        table.index("depends_on_id");
    });

    await knex.schema.alterTable("monitor", (table) => {
        table.integer("dependency_hold_seconds").notNullable().defaultTo(60);
    });
};

exports.down = async (knex) => {
    await knex.schema.dropTable("monitor_dependency");

    await knex.schema.alterTable("monitor", (table) => {
        table.dropColumn("dependency_hold_seconds");
    });
};

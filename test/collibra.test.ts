import * as assert from "assert";
import { CollibraClient } from "../src/collibra/CollibraClient";
import { SqlLineageExtractor } from "../src/parser/SqlLineageExtractor";
import { CollibraConnection } from "../src/types";

async function testCollibraIntegration() {
  console.log("Running CollibraClient Integration Test against live Collibra catalog...\n");

  const conn: CollibraConnection = {
    id: "test-conn",
    name: "Collibra Local Service",
    url: "http://localhost:8080",
    username: "admin",
    password: "password123"
  };

  const client = new CollibraClient(conn);

  // 1. Pagila Catalog Tests
  const filmAsset = await client.findAsset("pagila.film");
  assert.ok(filmAsset, "pagila.film should be found in Collibra catalog");
  assert.strictEqual(filmAsset.typeName, "Table");
  assert.strictEqual(filmAsset.status, "Approved");
  assert.strictEqual(filmAsset.attributes["Data Steward"], "sarah.content@enterprise.com");
  console.log("✓ Film asset verified from Collibra REST API v2:", filmAsset.name, filmAsset.status);

  const actorAsset = await client.findAsset("pagila.actor");
  assert.ok(actorAsset, "pagila.actor should be found in Collibra catalog");
  console.log("✓ Actor asset verified from Collibra REST API v2:", actorAsset.name);

  // 2. SingleStore Jaffle Shop Catalog Tests
  const rawCustomersAsset = await client.findAsset("landing.raw_customers");
  assert.ok(rawCustomersAsset, "landing.raw_customers should be found in Collibra catalog");
  assert.strictEqual(rawCustomersAsset.typeName, "Table");
  assert.strictEqual(rawCustomersAsset.status, "Approved");
  assert.ok(rawCustomersAsset.columns && rawCustomersAsset.columns.length >= 2, "raw_customers should contain columns");
  console.log(`✓ SingleStore Jaffle Shop raw_customers verified with ${rawCustomersAsset.columns?.length} columns (e.g. ${rawCustomersAsset.columns?.[0]?.name}: ${rawCustomersAsset.columns?.[0]?.dataType})`);

  const stgCustomersAsset = await client.findAsset("staging.stg_customers");
  assert.ok(stgCustomersAsset, "staging.stg_customers should be found in Collibra catalog");
  assert.strictEqual(stgCustomersAsset.typeName, "View");
  console.log("✓ SingleStore Jaffle Shop stg_customers verified:", stgCustomersAsset.name);

  const martCustomersAsset = await client.findAsset("presentation.customers");
  assert.ok(martCustomersAsset, "presentation.customers mart should be found in Collibra catalog");
  console.log("✓ SingleStore Jaffle Shop mart presentation.customers verified:", martCustomersAsset.name);

  // 3. Multi-hop Lineage Diagram (raw_customers -> stg_customers -> customers -> BI churn report)
  const lineage = await client.getAssetLineageRelations(stgCustomersAsset.id, 2, true);
  assert.ok(lineage.upstream.length > 0, "stg_customers should have upstream table (landing.raw_customers)");
  assert.ok(lineage.downstream.length > 0, "stg_customers should have downstream table (presentation.customers)");
  console.log("✓ stg_customers lineage relations:", {
    upstream: lineage.upstream.map(u => u.name),
    downstream: lineage.downstream.map(d => d.name)
  });

  // 4. Test building full lineage graph from dbt model
  const dbtCompiledQuery = `
    with customers as (
        select * from staging.stg_customers
    ),
    orders as (
        select * from staging.stg_orders
    )
    select * from customers left join orders using (customer_id);
  `;
  const dbtStmt = SqlLineageExtractor.analyzeStatement(dbtCompiledQuery, 0, 8, "landing", "singlestore");
  dbtStmt.statementType = "DBT_MODEL";
  dbtStmt.targetObjects = ["presentation.customers"];
  dbtStmt.allObjects = ["presentation.customers", "staging.stg_customers", "staging.stg_orders"];
  dbtStmt.origin = "dbt_target";

  const graph = await client.buildLineageGraph(dbtStmt, {
    depth: 2,
    showColumnLevel: true,
    showDataTypes: true
  });

  assert.ok(graph.nodes.length >= 4, "Graph should have query and at least 3 model/table nodes");
  assert.ok(graph.edges.length >= 3, "Graph should have edges connecting models to transformation");

  const graphCustomerNode = graph.nodes.find(n => n.name === "landing.raw_customers" || n.name === "staging.stg_customers");
  assert.ok(graphCustomerNode, "Graph should include cataloged SingleStore Jaffle Shop tables");
  assert.ok(graphCustomerNode.columns && graphCustomerNode.columns.length > 0, "Catalog node should include column list with data types");
  console.log(`✓ dbt SingleStore lineage graph built with ${graph.nodes.length} nodes, ${graph.edges.length} edges, and column-level metadata.`);

  console.log("\nALL COLLIBRA CLIENT INTEGRATION TESTS PASSED!");
}

testCollibraIntegration().catch(err => {
  console.error("Collibra test failed:", err);
  process.exit(1);
});

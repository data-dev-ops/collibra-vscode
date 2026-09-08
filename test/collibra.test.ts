import * as assert from "assert";
import { CollibraClient } from "../src/collibra/CollibraClient";
import { SqlLineageExtractor } from "../src/parser/SqlLineageExtractor";
import { CollibraConnection } from "../src/types";

async function testCollibraIntegration() {
  console.log("Running CollibraClient Integration Test against live Collibra container...");

  const conn: CollibraConnection = {
    id: "test-conn",
    name: "Pagila Collibra Local",
    url: "http://localhost:8080",
    username: "admin",
    password: "password123"
  };

  const client = new CollibraClient(conn);

  // Test finding pagila.film
  const filmAsset = await client.findAsset("pagila.film");
  assert.ok(filmAsset, "pagila.film should be found in Collibra catalog");
  assert.strictEqual(filmAsset.typeName, "Table");
  assert.strictEqual(filmAsset.status, "Approved");
  assert.strictEqual(filmAsset.attributes["Data Steward"], "sarah.content@enterprise.com");
  console.log("✓ Film asset verified from Collibra REST API v2:", filmAsset.name, filmAsset.status);

  // Test finding pagila.actor
  const actorAsset = await client.findAsset("pagila.actor");
  assert.ok(actorAsset, "pagila.actor should be found in Collibra catalog");
  console.log("✓ Actor asset verified from Collibra REST API v2:", actorAsset.name);

  // Test building full lineage graph from user query
  const query = "SELECT f.title, a.first_name FROM pagila.film f JOIN pagila.actor a ON 1=1;";
  const stmt = SqlLineageExtractor.analyzeStatement(query, 0, 0, "pagila");
  const graph = await client.buildLineageGraph(stmt);

  assert.ok(graph.nodes.length >= 3, "Graph should have query and at least 2 source nodes");
  assert.ok(graph.edges.length >= 2, "Graph should have edges from sources to query");

  console.log(`✓ Lineage graph generated with ${graph.nodes.length} nodes and ${graph.edges.length} edges`);

  // Test the user's specific query: Film, Film Actor, Actor
  const userMultiJoinQuery = `
    SELECT 
        f.film_id,
        f.title,
        f.release_year,
        f.rental_rate,
        a.first_name,
        a.last_name
    FROM pagila.film f
    JOIN pagila.film_actor fa ON f.film_id = fa.film_id
    JOIN pagila.actor a ON fa.actor_id = a.actor_id
    WHERE f.rental_rate > 2.99
    ORDER BY f.title ASC;
  `;
  const multiStmt = SqlLineageExtractor.analyzeStatement(userMultiJoinQuery, 0, 11, "pagila");
  const multiGraph = await client.buildLineageGraph(multiStmt);

  // Exclude current query node
  const dbNodes = multiGraph.nodes.filter(n => n.role !== "current_query");
  const actorNodes = dbNodes.filter(n => n.name === "pagila.actor");
  console.log("Multi-join query DB objects:", dbNodes.map(n => `${n.name} (${n.role}, attrs: ${Object.keys(n.attributes || {}).length})`));

  assert.strictEqual(actorNodes.length, 1, "pagila.actor must appear exactly ONCE (no duplicates)");
  assert.strictEqual(dbNodes.length, 3, "There should be exactly 3 unique database tables in the multi-join query");
  assert.ok(actorNodes[0].foundInCollibra, "Actor node must be found in Collibra");
  assert.ok(actorNodes[0].attributes && Object.keys(actorNodes[0].attributes).length > 0, "Actor node must have non-empty attributes");
  assert.ok(actorNodes[0].collibraUrl && actorNodes[0].collibraUrl.includes("assetId="), "Actor node must have working deep link URL");
  console.log("✓ User reported query test passed: 0 duplicates, exactly 3 tables, complete attributes and deep link.");

  console.log("\nALL COLLIBRA CLIENT INTEGRATION TESTS PASSED!");
}

testCollibraIntegration().catch(err => {
  console.error("Collibra test failed:", err);
  process.exit(1);
});

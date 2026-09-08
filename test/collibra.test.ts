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

  const filmNode = graph.nodes.find(n => n.name === "pagila.film");
  assert.ok(filmNode && filmNode.foundInCollibra, "Film node should have foundInCollibra = true");
  assert.strictEqual(filmNode.status, "Approved");

  console.log(`✓ Lineage graph generated with ${graph.nodes.length} nodes and ${graph.edges.length} edges`);
  console.log("\nALL COLLIBRA CLIENT INTEGRATION TESTS PASSED!");
}

testCollibraIntegration().catch(err => {
  console.error("Collibra test failed:", err);
  process.exit(1);
});

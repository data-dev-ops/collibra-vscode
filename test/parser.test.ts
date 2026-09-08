import * as assert from "assert";
import { SqlLineageExtractor } from "../src/parser/SqlLineageExtractor";

function testSqlLineageExtractor() {
  console.log("Running SqlLineageExtractor Test Suite...\n");

  // 1. User's exact requested query: select a.* from pagila.a a join pagila.b b where a.id = b.id
  const query1 = "select a.* from pagila.a a join pagila.b b where a.id = b.id;";
  const res1 = SqlLineageExtractor.analyzeStatement(query1, 0, 0, "pagila");
  console.log("Test 1 (User Query):", res1.sourceObjects);
  assert.strictEqual(res1.statementType, "SELECT");
  assert.ok(res1.sourceObjects.includes("pagila.a"), "Should extract pagila.a");
  assert.ok(res1.sourceObjects.includes("pagila.b"), "Should extract pagila.b");
  assert.strictEqual(res1.targetObjects.length, 0, "SELECT should have no DDL target object");
  console.log("✓ Test 1 Passed: Exact user query extracts pagila.a and pagila.b");

  // 2. Multi-table join across Pagila tables
  const query2 = `
    -- Film actor join
    SELECT f.title, a.first_name, a.last_name
    FROM pagila.film f
    JOIN pagila.film_actor fa ON f.film_id = fa.film_id
    JOIN pagila.actor a ON fa.actor_id = a.actor_id
    WHERE f.rental_rate > 2.99;
  `;
  const res2 = SqlLineageExtractor.analyzeStatement(query2, 1, 6, "pagila");
  assert.strictEqual(res2.statementType, "SELECT");
  assert.ok(res2.sourceObjects.includes("pagila.film"));
  assert.ok(res2.sourceObjects.includes("pagila.film_actor"));
  assert.ok(res2.sourceObjects.includes("pagila.actor"));
  console.log("✓ Test 2 Passed: Multi-join with comments extracts all 3 tables");

  // 3. CREATE TABLE AS SELECT
  const query3 = `
    CREATE TABLE pagila.customer_summary AS
    SELECT c.customer_id, count(r.rental_id) as total_rentals
    FROM pagila.customer c
    LEFT JOIN pagila.rental r ON c.customer_id = r.customer_id
    GROUP BY c.customer_id;
  `;
  const res3 = SqlLineageExtractor.analyzeStatement(query3, 0, 5, "pagila");
  assert.strictEqual(res3.statementType, "CREATE_TABLE_AS");
  assert.ok(res3.targetObjects.includes("pagila.customer_summary"), "Target should be customer_summary");
  assert.ok(res3.sourceObjects.includes("pagila.customer"));
  assert.ok(res3.sourceObjects.includes("pagila.rental"));
  console.log("✓ Test 3 Passed: CREATE TABLE AS extracts target and sources");

  // 4. CREATE VIEW
  const query4 = `
    CREATE OR REPLACE VIEW pagila.top_rentals AS
    SELECT i.film_id, count(*) as count
    FROM pagila.rental r
    JOIN pagila.inventory i ON r.inventory_id = i.inventory_id
    GROUP BY i.film_id;
  `;
  const res4 = SqlLineageExtractor.analyzeStatement(query4, 0, 5, "pagila");
  assert.strictEqual(res4.statementType, "CREATE_VIEW");
  assert.ok(res4.targetObjects.includes("pagila.top_rentals"));
  assert.ok(res4.sourceObjects.includes("pagila.rental"));
  assert.ok(res4.sourceObjects.includes("pagila.inventory"));
  console.log("✓ Test 4 Passed: CREATE VIEW extracts view target and joined sources");

  // 5. ALTER TABLE
  const query5 = "ALTER TABLE pagila.film ADD COLUMN rating_custom VARCHAR(10);";
  const res5 = SqlLineageExtractor.analyzeStatement(query5, 0, 0, "pagila");
  assert.strictEqual(res5.statementType, "ALTER_TABLE");
  assert.ok(res5.targetObjects.includes("pagila.film"));
  console.log("✓ Test 5 Passed: ALTER TABLE extracts target table");

  // 6. Splitting multiple statements in a scratchpad
  const scratchpad = `
    -- Statement 1
    SELECT * FROM pagila.customer WHERE active = 1;

    -- Statement 2
    SELECT f.film_id, f.title FROM pagila.film f JOIN pagila.category c ON 1=1;

    -- Statement 3 with string containing semicolon
    INSERT INTO pagila.film_notes (note) VALUES ('test; note with semicolon');
  `;
  const stmts = SqlLineageExtractor.splitSqlStatements(scratchpad);
  assert.strictEqual(stmts.length, 3, "Should correctly split 3 statements");
  console.log("✓ Test 6 Passed: Scratchpad statement splitter works with string quotes and comments");

  // 7. Unqualified table defaults to default schema
  const query7 = "SELECT * FROM film f JOIN actor a ON f.id = a.id;";
  const res7 = SqlLineageExtractor.analyzeStatement(query7, 0, 0, "pagila");
  assert.ok(res7.sourceObjects.includes("pagila.film"));
  assert.ok(res7.sourceObjects.includes("pagila.actor"));
  console.log("✓ Test 7 Passed: Unqualified tables default to configured schema");

  console.log("\nALL PARSER TESTS PASSED!");
}

testSqlLineageExtractor();

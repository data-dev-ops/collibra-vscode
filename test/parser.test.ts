import * as assert from "assert";
import * as path from "path";
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

  // 8. SingleStore Dialect (Backticks & Columnstore/Rowstore DDL)
  const singleStoreQuery = "SELECT * FROM `landing`.`raw_orders` o JOIN `landing`.`raw_customers` c ON o.customer = c.id;";
  const res8 = SqlLineageExtractor.analyzeStatement(singleStoreQuery, 0, 0, "landing", "singlestore");
  assert.ok(res8.sourceObjects.includes("landing.raw_orders"), "Should extract landing.raw_orders without backticks");
  assert.ok(res8.sourceObjects.includes("landing.raw_customers"), "Should extract landing.raw_customers without backticks");

  const singleStoreDdl = `
    CREATE COLUMNSTORE TABLE landing.orders_summary (
      order_id VARCHAR(36),
      order_total NUMERIC(12,4),
      SHARD KEY (order_id)
    );
  `;
  const resDdl = SqlLineageExtractor.analyzeStatement(singleStoreDdl, 0, 5, "landing", "singlestore");
  assert.strictEqual(resDdl.statementType, "CREATE_TABLE_AS");
  assert.ok(resDdl.targetObjects.includes("landing.orders_summary"));
  console.log("✓ Test 8 Passed: SingleStore dialect handles backticks and COLUMNSTORE DDL");

  // 9. dbt Manifest-First Lineage Extraction (from dbt-academy/target/manifest.json)
  const dbtProjectRoot = path.resolve(__dirname, "../../../dbt-academy");
  const mockStgDoc: any = {
    fileName: path.join(dbtProjectRoot, "models/staging/stg_customers.sql"),
    getText: () => "select id as customer_id, name as customer_name from {{ source('landing', 'raw_customers') }}",
    lineCount: 1
  };
  const resManifestStg = SqlLineageExtractor.extractFromDbtManifest(mockStgDoc, dbtProjectRoot, "singlestore", "landing");
  assert.strictEqual(resManifestStg.statementType, "DBT_MODEL");
  assert.strictEqual(resManifestStg.origin, "dbt_manifest");
  assert.strictEqual(resManifestStg.manifestMissing, false);
  assert.ok(resManifestStg.targetObjects.includes("staging.stg_customers"), "Target must be staging.stg_customers from manifest");
  assert.ok(resManifestStg.sourceObjects.includes("landing.raw_customers"), "Source must be landing.raw_customers from manifest");
  assert.strictEqual(resManifestStg.manifestDetails?.schema, "staging");
  assert.strictEqual(resManifestStg.manifestDetails?.alias, "stg_customers");
  assert.ok(resManifestStg.columnMetadataMap?.["staging.stg_customers"], "Must include column metadata for target");
  assert.ok(resManifestStg.columnMetadataMap?.["landing.raw_customers"], "Must include column metadata for upstream source");
  console.log("✓ Test 9 Passed: dbt manifest extraction resolves exact staging model and source with columns");

  // 10. dbt Mart Multi-Dependency Lineage Extraction
  const mockMartDoc: any = {
    fileName: path.join(dbtProjectRoot, "models/marts/customers.sql"),
    getText: () => "select * from {{ ref('stg_customers') }} join {{ ref('stg_orders') }} using (customer_id)",
    lineCount: 1
  };
  const resManifestMart = SqlLineageExtractor.extractFromDbtManifest(mockMartDoc, dbtProjectRoot, "singlestore", "landing");
  assert.ok(resManifestMart.targetObjects.includes("presentation.customers"));
  assert.ok(resManifestMart.sourceObjects.includes("staging.stg_customers"));
  assert.ok(resManifestMart.sourceObjects.includes("staging.stg_orders"));
  assert.strictEqual(resManifestMart.manifestDetails?.schema, "presentation");
  console.log("✓ Test 10 Passed: dbt manifest extraction resolves mart with multi-model dependencies");

  // 11. Missing Target / Manifest handling
  const mockMissingDoc: any = {
    fileName: "/tmp/nonexistent_dbt_project/models/foo.sql",
    getText: () => "select 1",
    lineCount: 1
  };
  const resMissing = SqlLineageExtractor.extractFromDbtManifest(mockMissingDoc, "/tmp/nonexistent_dbt_project", "singlestore", "landing");
  assert.strictEqual(resMissing.manifestMissing, true, "Must flag manifestMissing as true");
  assert.strictEqual(resMissing.targetObjects.length, 0, "Must not fabricate target objects when manifest is missing");
  assert.strictEqual(resMissing.sourceObjects.length, 0, "Must not fabricate source objects when manifest is missing");
  console.log("✓ Test 11 Passed: Missing target/manifest.json is cleanly flagged without guessing");

  console.log("\nALL PARSER TESTS PASSED!");
}

testSqlLineageExtractor();

# Collibra SQL Lineage - VS Code Extension

An interactive VS Code extension providing cursor-aware SQL query analysis and real-time Collibra Data Governance catalog integration.

## Features

- **Cursor-Aware Query Extraction**:
  - Automatically isolates the active query under your cursor in multi-statement SQL scratchpads.
  - Understands statement boundaries, comments, and string literals.
- **SQL Lineage Parsing**:
  - Extracts upstream source tables from `FROM`, `JOIN`, subqueries, and CTEs.
  - Extracts target objects from `CREATE TABLE ... AS`, `CREATE VIEW`, `ALTER TABLE`, and `INSERT INTO`.
  - For example, a query:
    ```sql
    select a.* from pagila.a a join pagila.b b where a.id = b.id;
    ```
    identifies `pagila.a` and `pagila.b` being used for the current query object.
- **Collibra REST API v2 Integration**:
  - Connects to any running Collibra instance (e.g. `http://localhost:8080` or `https://instance.collibra.com`).
  - Fetches asset governance status ("Approved", "Candidate"), Data Stewards, certifications, descriptions, quality scores, and upstream/downstream catalog relations.
  - Interactive "View in Collibra" deep links.
- **Visual Lineage Graph Webview**:
  - Displays directed data flow: Upstream Sources ➔ Active Query ➔ Downstream Targets ➔ Downstream BI Products.
  - Clicking any node inspects Collibra attributes in a dedicated drawer.
- **Connection Management Form**:
  - Dedicated Connection Manager UI to add, test, edit, and switch active Collibra endpoints with live connectivity diagnostics.

## Extension Views & Commands

- **Collibra Activity Bar Icon**: Click the Collibra emblem in the activity bar to open the Lineage and Connection panels.
- **Active Query Lineage View**: Real-time diagram updating as cursor moves across SQL queries.
- **Collibra Connection View**: Form to manage and test Collibra connections.
- **Commands**:
  - `Collibra: Open Lineage Explorer` (`collibra.openLineage`)
  - `Collibra: Refresh Lineage at Cursor` (`collibra.refreshLineage`)
  - `Collibra: Manage Connections` (`collibra.manageConnections`)
  - `Collibra: Test Active Connection` (`collibra.testActiveConnection`)

## Building and Packaging

```bash
npm install
npm run compile
npm test
npx @vscode/vsce package --no-dependencies
```
Produces `collibra-lineage-0.1.0.vsix`.

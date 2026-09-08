import {
  CollibraConnection,
  CollibraAsset,
  SqlStatementInfo,
  LineageGraphData,
  LineageGraphNode,
  LineageGraphEdge
} from "../types";

export class CollibraClient {
  private assetCache = new Map<string, CollibraAsset | null>();

  constructor(private connection: CollibraConnection | null) {}

  public setConnection(conn: CollibraConnection | null): void {
    this.connection = conn;
    this.assetCache.clear();
  }

  private getAuthHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Accept": "application/json"
    };
    if (this.connection && this.connection.username) {
      const creds = `${this.connection.username}:${this.connection.password || ""}`;
      headers["Authorization"] = "Basic " + Buffer.from(creds).toString("base64");
    }
    return headers;
  }

  private getBaseUrl(): string {
    if (!this.connection || !this.connection.url) {
      return "http://localhost:8080";
    }
    return this.connection.url.replace(/\/+$/, "");
  }

  /**
   * Searches Collibra catalog for an asset matching the given table/view name.
   */
  public async findAsset(objectName: string): Promise<CollibraAsset | null> {
    if (!this.connection) return null;

    const cacheKey = objectName.toLowerCase();
    if (this.assetCache.has(cacheKey)) {
      return this.assetCache.get(cacheKey) || null;
    }

    try {
      const baseUrl = this.getBaseUrl();
      // Try exact name match
      let url = `${baseUrl}/rest/2.0/assets?name=${encodeURIComponent(objectName)}&nameMatchMode=EXACT&limit=5`;
      let res = await fetch(url, { headers: this.getAuthHeaders() });

      let data: any = null;
      if (res.ok) {
        data = await res.json();
      }

      // If not found and objectName has schema (e.g. "pagila.film"), try table name "film"
      if ((!data || !data.results || data.results.length === 0) && objectName.includes(".")) {
        const shortName = objectName.split(".").pop()!;
        url = `${baseUrl}/rest/2.0/assets?name=${encodeURIComponent(shortName)}&nameMatchMode=EXACT&limit=5`;
        res = await fetch(url, { headers: this.getAuthHeaders() });
        if (res.ok) {
          data = await res.json();
        }
      }

      if (data && data.results && data.results.length > 0) {
        const raw = data.results[0];
        const asset: CollibraAsset = {
          id: raw.id,
          name: raw.name,
          displayName: raw.displayName || raw.name,
          typeName: raw.typeName || "Table",
          domainId: raw.domainId,
          status: raw.status || "Approved",
          attributes: raw.attributes || {},
          collibraUrl: `${baseUrl}/?assetId=${encodeURIComponent(raw.id)}#asset/${encodeURIComponent(raw.id)}`
        };
        this.assetCache.set(cacheKey, asset);
        return asset;
      }

      this.assetCache.set(cacheKey, null);
      return null;
    } catch (err) {
      console.warn(`Collibra lookup failed for ${objectName}:`, err);
      return null;
    }
  }

  /**
   * Fetches upstream and downstream lineage from Collibra for a cataloged asset.
   */
  public async getAssetLineageRelations(assetId: string): Promise<{
    upstream: Array<{ id: string; name: string; type: string }>;
    downstream: Array<{ id: string; name: string; type: string }>;
  }> {
    const upstream: Array<{ id: string; name: string; type: string }> = [];
    const downstream: Array<{ id: string; name: string; type: string }> = [];

    if (!this.connection) return { upstream, downstream };

    try {
      const baseUrl = this.getBaseUrl();
      const res = await fetch(`${baseUrl}/rest/2.0/diagrams/lineage/${assetId}`, {
        headers: this.getAuthHeaders()
      });

      if (res.ok) {
        const data: any = await res.json();
        const nodes = data.nodes || [];
        const edges = data.edges || [];

        for (const edge of edges) {
          if (edge.target === assetId) {
            const srcNode = nodes.find((n: any) => n.id === edge.source);
            if (srcNode) {
              upstream.push({ id: srcNode.id, name: srcNode.name, type: srcNode.type });
            }
          } else if (edge.source === assetId) {
            const tgtNode = nodes.find((n: any) => n.id === edge.target);
            if (tgtNode) {
              downstream.push({ id: tgtNode.id, name: tgtNode.name, type: tgtNode.type });
            }
          }
        }
      }
    } catch (err) {
      console.warn("Error fetching Collibra lineage diagram:", err);
    }

    return { upstream, downstream };
  }

  /**
   * Constructs an interactive lineage graph combining:
   * 1. The parsed SQL statement (sources -> query -> targets)
   * 2. Live Collibra catalog metadata & upstream/downstream relations
   * Ensures zero duplicate nodes by canonicalizing table names.
   */
  public async buildLineageGraph(statement: SqlStatementInfo): Promise<LineageGraphData> {
    const canonicalKey = (name: string) => name.toLowerCase().trim();
    const nodeMap = new Map<string, LineageGraphNode>();
    const edges: LineageGraphEdge[] = [];
    const edgeSet = new Set<string>();

    const addEdge = (sourceId: string, targetId: string, label: string, type: "query_flow" | "catalog_flow") => {
      const key = `${sourceId}->${targetId}`;
      if (!edgeSet.has(key) && sourceId !== targetId) {
        edgeSet.add(key);
        edges.push({
          id: `edge-${sourceId}->${targetId}`,
          source: sourceId,
          target: targetId,
          label,
          type
        });
      }
    };

    const queryNodeId = "node-current-query";
    let queryTitle = "Current Query";
    if (statement.statementType === "SELECT") {
      queryTitle = "Query Result (SELECT)";
    } else if (statement.statementType === "CREATE_TABLE_AS") {
      queryTitle = "CREATE TABLE";
    } else if (statement.statementType === "CREATE_VIEW") {
      queryTitle = "CREATE VIEW";
    } else if (statement.statementType === "ALTER_TABLE") {
      queryTitle = "ALTER TABLE";
    }

    // Current Query Transformation Node
    const queryNode: LineageGraphNode = {
      id: queryNodeId,
      name: queryTitle,
      displayName: queryTitle,
      type: statement.statementType,
      role: "current_query",
      foundInCollibra: false
    };

    // 1. Process Source Tables from Query
    for (const src of statement.sourceObjects) {
      const key = canonicalKey(src);
      let node = nodeMap.get(key);

      if (!node) {
        const collibraAsset = await this.findAsset(src);
        node = {
          id: `node-${key}`,
          name: src,
          displayName: collibraAsset?.displayName || src.split(".").pop() || src,
          type: collibraAsset?.typeName || "Table",
          role: "source",
          status: collibraAsset?.status || (collibraAsset ? "Approved" : "Not Cataloged"),
          attributes: collibraAsset?.attributes,
          foundInCollibra: !!collibraAsset,
          collibraUrl: collibraAsset?.collibraUrl
        };
        nodeMap.set(key, node);
      } else {
        // If it was previously introduced via catalog relation, promote to direct query source
        node.role = "source";
      }

      // Edge: source -> current query
      addEdge(node.id, queryNodeId, "Used in query", "query_flow");

      // Pull 1 level of upstream lineage from Collibra
      const asset = await this.findAsset(src);
      if (asset) {
        const lin = await this.getAssetLineageRelations(asset.id);
        for (const up of lin.upstream.slice(0, 3)) {
          const upKey = canonicalKey(up.name);
          let upNode = nodeMap.get(upKey);

          if (!upNode) {
            // Fetch full asset for the upstream catalog node so it has complete attributes and link
            const fullUpAsset = await this.findAsset(up.name);
            upNode = {
              id: `node-${upKey}`,
              name: up.name,
              displayName: fullUpAsset?.displayName || up.name.split(".").pop() || up.name,
              type: fullUpAsset?.typeName || up.type,
              role: "catalog_upstream",
              status: fullUpAsset?.status || "Approved",
              attributes: fullUpAsset?.attributes || {},
              foundInCollibra: !!fullUpAsset,
              collibraUrl: fullUpAsset?.collibraUrl
            };
            nodeMap.set(upKey, upNode);
          }

          // Edge: upstream -> source table
          addEdge(upNode.id, node.id, "Feeds", "catalog_flow");
        }
      }
    }

    // 2. Process Target Tables (for CREATE TABLE/VIEW, ALTER, INSERT)
    for (const tgt of statement.targetObjects) {
      const key = canonicalKey(tgt);
      let node = nodeMap.get(key);

      if (!node) {
        const collibraAsset = await this.findAsset(tgt);
        node = {
          id: `node-${key}`,
          name: tgt,
          displayName: collibraAsset?.displayName || tgt.split(".").pop() || tgt,
          type: collibraAsset?.typeName || (statement.statementType === "CREATE_VIEW" ? "View" : "Table"),
          role: "target",
          status: collibraAsset?.status || (collibraAsset ? "Approved" : "Proposed / DDL"),
          attributes: collibraAsset?.attributes,
          foundInCollibra: !!collibraAsset,
          collibraUrl: collibraAsset?.collibraUrl
        };
        nodeMap.set(key, node);
      } else {
        node.role = "target";
      }

      // Edge: current query -> target
      addEdge(queryNodeId, node.id, statement.statementType === "CREATE_VIEW" ? "Defines View" : "Produces Data", "query_flow");

      // Pull 1 level of downstream lineage from Collibra
      const asset = await this.findAsset(tgt);
      if (asset) {
        const lin = await this.getAssetLineageRelations(asset.id);
        for (const down of lin.downstream.slice(0, 3)) {
          const downKey = canonicalKey(down.name);
          let downNode = nodeMap.get(downKey);

          if (!downNode) {
            const fullDownAsset = await this.findAsset(down.name);
            downNode = {
              id: `node-${downKey}`,
              name: down.name,
              displayName: fullDownAsset?.displayName || down.name.split(".").pop() || down.name,
              type: fullDownAsset?.typeName || down.type,
              role: "catalog_downstream",
              status: fullDownAsset?.status || "Approved",
              attributes: fullDownAsset?.attributes || {},
              foundInCollibra: !!fullDownAsset,
              collibraUrl: fullDownAsset?.collibraUrl
            };
            nodeMap.set(downKey, downNode);
          }

          addEdge(node.id, downNode.id, "Feeds BI", "catalog_flow");
        }
      }
    }

    const allNodes = [queryNode, ...Array.from(nodeMap.values())];

    return {
      statementInfo: statement,
      activeConnectionName: this.connection?.name || "None (Disconnected)",
      nodes: allNodes,
      edges,
      timestamp: Date.now()
    };
  }
}

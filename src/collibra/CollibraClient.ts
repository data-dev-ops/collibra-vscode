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
          collibraUrl: `${baseUrl}/#asset/${raw.id}`
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
   */
  public async buildLineageGraph(statement: SqlStatementInfo): Promise<LineageGraphData> {
    const nodes: LineageGraphNode[] = [];
    const edges: LineageGraphEdge[] = [];
    const nodeMap = new Set<string>();

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

    // Add Current Query Node
    nodes.push({
      id: queryNodeId,
      name: queryTitle,
      displayName: queryTitle,
      type: statement.statementType,
      role: "current_query",
      foundInCollibra: false
    });
    nodeMap.add(queryNodeId);

    // Process Source Tables
    for (const src of statement.sourceObjects) {
      const collibraAsset = await this.findAsset(src);
      const nodeId = `node-src-${src}`;
      if (!nodeMap.has(nodeId)) {
        nodes.push({
          id: nodeId,
          name: src,
          displayName: collibraAsset?.displayName || src.split(".").pop() || src,
          type: collibraAsset?.typeName || "Table",
          role: "source",
          status: collibraAsset?.status || (collibraAsset ? "Approved" : "Not Cataloged"),
          attributes: collibraAsset?.attributes,
          foundInCollibra: !!collibraAsset,
          collibraUrl: collibraAsset?.collibraUrl
        });
        nodeMap.add(nodeId);
      }

      // Edge from source to current query
      edges.push({
        id: `edge-${src}->query`,
        source: nodeId,
        target: queryNodeId,
        label: "Used in query",
        type: "query_flow"
      });

      // If asset has upstream relations in Collibra, pull 1 level of upstream
      if (collibraAsset) {
        const lin = await this.getAssetLineageRelations(collibraAsset.id);
        for (const up of lin.upstream.slice(0, 2)) {
          const upNodeId = `node-cat-${up.id}`;
          if (!nodeMap.has(upNodeId)) {
            nodes.push({
              id: upNodeId,
              name: up.name,
              displayName: up.name.split(".").pop() || up.name,
              type: up.type,
              role: "catalog_upstream",
              status: "Approved",
              foundInCollibra: true
            });
            nodeMap.add(upNodeId);
          }
          edges.push({
            id: `edge-${up.id}->${collibraAsset.id}`,
            source: upNodeId,
            target: nodeId,
            label: "Feeds",
            type: "catalog_flow"
          });
        }
      }
    }

    // Process Target Tables (for CREATE TABLE/VIEW, ALTER, INSERT)
    for (const tgt of statement.targetObjects) {
      const collibraAsset = await this.findAsset(tgt);
      const nodeId = `node-tgt-${tgt}`;
      if (!nodeMap.has(nodeId)) {
        nodes.push({
          id: nodeId,
          name: tgt,
          displayName: collibraAsset?.displayName || tgt.split(".").pop() || tgt,
          type: collibraAsset?.typeName || (statement.statementType === "CREATE_VIEW" ? "View" : "Table"),
          role: "target",
          status: collibraAsset?.status || (collibraAsset ? "Approved" : "Proposed / DDL"),
          attributes: collibraAsset?.attributes,
          foundInCollibra: !!collibraAsset,
          collibraUrl: collibraAsset?.collibraUrl
        });
        nodeMap.add(nodeId);
      }

      // Edge from current query to target
      edges.push({
        id: `edge-query->${tgt}`,
        source: queryNodeId,
        target: nodeId,
        label: statement.statementType === "CREATE_VIEW" ? "Defines View" : "Produces Data",
        type: "query_flow"
      });

      // If asset has downstream relations in Collibra, pull 1 level of downstream
      if (collibraAsset) {
        const lin = await this.getAssetLineageRelations(collibraAsset.id);
        for (const down of lin.downstream.slice(0, 2)) {
          const downNodeId = `node-cat-${down.id}`;
          if (!nodeMap.has(downNodeId)) {
            nodes.push({
              id: downNodeId,
              name: down.name,
              displayName: down.name.split(".").pop() || down.name,
              type: down.type,
              role: "catalog_downstream",
              status: "Approved",
              foundInCollibra: true
            });
            nodeMap.add(downNodeId);
          }
          edges.push({
            id: `edge-${collibraAsset.id}->${down.id}`,
            source: nodeId,
            target: downNodeId,
            label: "Feeds BI",
            type: "catalog_flow"
          });
        }
      }
    }

    return {
      statementInfo: statement,
      activeConnectionName: this.connection?.name || "None (Disconnected)",
      nodes,
      edges,
      timestamp: Date.now()
    };
  }
}

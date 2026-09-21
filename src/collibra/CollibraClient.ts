import {
  CollibraConnection,
  CollibraAsset,
  SqlStatementInfo,
  LineageGraphData,
  LineageGraphNode,
  LineageGraphEdge,
  LineageGraphSettings,
  ColumnInfo
} from "../types";

export interface BuildLineageGraphOptions {
  depth?: number;
  showColumnLevel?: boolean;
  showDataTypes?: boolean;
  settings?: LineageGraphSettings;
  availableConnections?: Array<{ id: string; name: string; isDefault?: boolean }>;
  activeConnectionId?: string;
}

export class CollibraClient {
  private assetCache = new Map<string, CollibraAsset | null>();
  private resolvedBaseUrl: string | null = null;
  private isOnline = true;
  private lastHealthCheckTime = 0;

  constructor(private connection: CollibraConnection | null) {}

  public setConnection(conn: CollibraConnection | null): void {
    this.connection = conn;
    this.resolvedBaseUrl = null;
    this.isOnline = true;
    this.lastHealthCheckTime = 0;
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

  public getCandidateUrls(inputUrl?: string): string[] {
    const raw = (inputUrl || this.connection?.url || process.env.COLLIBRA_URL || "http://localhost:8080")
      .trim()
      .replace(/\/+$/, "");
    const candidates: string[] = [];

    if (/collibra-service/.test(raw)) {
      // In host environment outside Docker, localhost resolves while collibra-service fails DNS
      candidates.push(raw.replace("collibra-service", "localhost"));
      candidates.push(raw.replace("collibra-service", "127.0.0.1"));
      candidates.push(raw);
    } else if (/localhost|127\.0\.0\.1/.test(raw)) {
      candidates.push(raw);
      candidates.push(raw.replace(/localhost|127\.0\.0\.1/, "127.0.0.1"));
      candidates.push(raw.replace(/localhost|127\.0\.0\.1/, "collibra-service"));
    } else {
      candidates.push(raw);
    }

    if (process.env.COLLIBRA_URL) {
      candidates.push(process.env.COLLIBRA_URL.trim().replace(/\/+$/, ""));
    }

    return Array.from(new Set(candidates));
  }

  public async checkHealth(force = false): Promise<{ online: boolean; url: string | null }> {
    const now = Date.now();
    // Cache positive health check for 15s, negative for 3s
    if (!force && this.resolvedBaseUrl && this.isOnline && (now - this.lastHealthCheckTime < 15000)) {
      return { online: true, url: this.resolvedBaseUrl };
    }
    if (!force && !this.isOnline && (now - this.lastHealthCheckTime < 3000)) {
      return { online: false, url: null };
    }

    const candidates = this.getCandidateUrls();
    for (const testUrl of candidates) {
      try {
        const res = await fetch(`${testUrl}/health`, { signal: AbortSignal.timeout(600) });
        if (res.ok) {
          this.resolvedBaseUrl = testUrl;
          this.isOnline = true;
          this.lastHealthCheckTime = now;
          return { online: true, url: testUrl };
        }
      } catch (e) {
        // try next candidate
      }
    }

    this.isOnline = false;
    this.lastHealthCheckTime = now;
    return { online: false, url: null };
  }

  public async getWorkingBaseUrl(): Promise<string> {
    const health = await this.checkHealth();
    if (health.online && health.url) {
      return health.url;
    }
    const candidates = this.getCandidateUrls();
    return candidates[0];
  }

  public getAssetWebUrl(assetId: string): string {
    const base = (this.resolvedBaseUrl || this.connection?.url || "http://localhost:8080").replace(/\/+$/, "");
    const browserBase = base.replace("collibra-service", "localhost");
    return `${browserBase}/?assetId=${encodeURIComponent(assetId)}#asset/${encodeURIComponent(assetId)}`;
  }

  /**
   * Searches Collibra catalog for an asset matching the given table/view name.
   */
  public async findAsset(objectName: string, signal?: AbortSignal): Promise<CollibraAsset | null> {
    if (!this.connection && !process.env.COLLIBRA_URL) return null;

    const cacheKey = objectName.toLowerCase();
    if (this.assetCache.has(cacheKey)) {
      return this.assetCache.get(cacheKey) || null;
    }

    const health = await this.checkHealth();
    if (!health.online || !health.url) {
      return null;
    }

    const baseUrl = health.url;
    try {
      // 1. Try exact qualified name match (e.g. staging.stg_customers)
      let url = `${baseUrl}/rest/2.0/assets?name=${encodeURIComponent(objectName)}&nameMatchMode=EXACT&limit=5`;
      let res: Response;
      try {
        res = await fetch(url, { headers: this.getAuthHeaders(), signal: signal || AbortSignal.timeout(1200) });
      } catch (fetchErr: any) {
        if (fetchErr?.name === "AbortError") throw fetchErr;
        return null;
      }

      let data: any = null;
      if (res.ok) {
        data = await res.json();
      }

      // 2. If not found and objectName has schema (e.g. "staging.stg_customers"), try short table name "stg_customers"
      if ((!data || !data.results || data.results.length === 0) && objectName.includes(".")) {
        const shortName = objectName.split(".").pop()!;
        url = `${baseUrl}/rest/2.0/assets?name=${encodeURIComponent(shortName)}&nameMatchMode=EXACT&limit=5`;
        try {
          res = await fetch(url, { headers: this.getAuthHeaders(), signal: signal || AbortSignal.timeout(1200) });
          if (res.ok) {
            data = await res.json();
          }
        } catch (fetchErr: any) {
          if (fetchErr?.name === "AbortError") throw fetchErr;
        }
      }

      if (data && data.results && data.results.length > 0) {
        const raw = data.results[0];

        // Also fetch column list if available via diagram lineage
        let columns: ColumnInfo[] = [];
        try {
          const diagUrl = `${baseUrl}/rest/2.0/diagrams/lineage/${raw.id}?depth=1&includeColumns=true`;
          const diagRes = await fetch(diagUrl, { headers: this.getAuthHeaders(), signal: signal || AbortSignal.timeout(1000) });
          if (diagRes.ok) {
            const diagData: any = await diagRes.json();
            const rootNode = diagData.nodes?.find((n: any) => n.id === raw.id);
            if (rootNode && Array.isArray(rootNode.columns)) {
              columns = rootNode.columns;
            }
          }
        } catch (e: any) {
          if (e?.name === "AbortError") throw e;
        }

        const asset: CollibraAsset = {
          id: raw.id,
          name: raw.name,
          displayName: raw.displayName || raw.name,
          typeName: raw.typeName || (raw.type && raw.type.name) || "Table",
          domainId: raw.domainId || (raw.domain && raw.domain.id),
          status: raw.status?.name || raw.status || "Approved",
          attributes: raw.attributes || {},
          columns,
          collibraUrl: this.getAssetWebUrl(raw.id)
        };
        this.assetCache.set(cacheKey, asset);
        return asset;
      }
    } catch (err: any) {
      if (err?.name === "AbortError") throw err;
    }

    this.assetCache.set(cacheKey, null);
    return null;
  }

  /**
   * Fetches upstream and downstream relations for a given asset from Collibra diagram API.
   */
  public async getAssetLineageRelations(
    assetId: string,
    depth: number = 2,
    includeColumns: boolean = true,
    signal?: AbortSignal
  ): Promise<{
    upstream: Array<{ id: string; name: string; type: string; columns?: ColumnInfo[]; attributes?: Record<string, string> }>;
    downstream: Array<{ id: string; name: string; type: string; columns?: ColumnInfo[]; attributes?: Record<string, string> }>;
  }> {
    const upstream: Array<{ id: string; name: string; type: string; columns?: ColumnInfo[]; attributes?: Record<string, string> }> = [];
    const downstream: Array<{ id: string; name: string; type: string; columns?: ColumnInfo[]; attributes?: Record<string, string> }> = [];

    const health = await this.checkHealth();
    if (!health.online || !health.url) {
      return { upstream, downstream };
    }

    try {
      const baseUrl = health.url;
      const url = `${baseUrl}/rest/2.0/diagrams/lineage/${encodeURIComponent(assetId)}?depth=${depth}&includeColumns=${includeColumns}`;
      const res = await fetch(url, { headers: this.getAuthHeaders(), signal: signal || AbortSignal.timeout(1500) });
      if (res.ok) {
        const data: any = await res.json();
        const nodes = data.nodes || [];
        const edges = data.edges || [];

        for (const edge of edges) {
          if (edge.target === assetId) {
            const srcNode = nodes.find((n: any) => n.id === edge.source);
            if (srcNode && !upstream.some(u => u.id === srcNode.id)) {
              upstream.push({
                id: srcNode.id,
                name: srcNode.name,
                type: srcNode.type,
                columns: srcNode.columns,
                attributes: srcNode.attributes
              });
            }
          } else if (edge.source === assetId) {
            const tgtNode = nodes.find((n: any) => n.id === edge.target);
            if (tgtNode && !downstream.some(d => d.id === tgtNode.id)) {
              downstream.push({
                id: tgtNode.id,
                name: tgtNode.name,
                type: tgtNode.type,
                columns: tgtNode.columns,
                attributes: tgtNode.attributes
              });
            }
          }
        }
      }
    } catch (err: any) {
      if (err?.name === "AbortError") throw err;
      console.warn("Error fetching Collibra lineage diagram:", err);
    }

    return { upstream, downstream };
  }

  /**
   * Constructs an interactive lineage graph combining:
   * 1. The parsed SQL statement or dbt manifest
   * 2. Live Collibra catalog metadata, columns, and relations
   */
  public async buildLineageGraph(
    statement: SqlStatementInfo,
    options?: BuildLineageGraphOptions,
    signal?: AbortSignal
  ): Promise<LineageGraphData> {
    const isDbt = statement.statementType === "DBT_MODEL" || statement.projectType === "dbt";

    // Handle missing dbt manifest immediately
    if (statement.manifestMissing) {
      return {
        statementInfo: statement,
        activeConnectionName: this.connection?.name || "None (Disconnected)",
        activeConnectionId: options?.activeConnectionId || this.connection?.id,
        availableConnections: options?.availableConnections,
        settings: options?.settings,
        nodes: [],
        edges: [],
        timestamp: Date.now(),
        manifestMissing: true,
        manifestPath: statement.resolvedFilePath,
        errorMessage: "target/manifest.json not found in dbt project. Lineage cannot be determined without manifest. Run 'dbt compile' in your terminal."
      };
    }

    const canonicalKey = (name: string) => name.toLowerCase().trim();
    const nodeMap = new Map<string, LineageGraphNode>();
    const edges: LineageGraphEdge[] = [];
    const edgeSet = new Set<string>();

    const depth = options?.depth || options?.settings?.depth || 2;
    const includeColumns = options?.showColumnLevel !== false;

    const addEdge = (sourceId: string, targetId: string, label: string, type: "query_flow" | "catalog_flow" | "column_flow") => {
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
    } else if (statement.statementType === "DBT_MODEL") {
      queryTitle = statement.manifestDetails?.alias
        ? `dbt: ${statement.manifestDetails.alias}`
        : "dbt Model Transformation";
    }

    // Current Query Transformation Node
    const isDdl = statement.statementType.startsWith("CREATE") || statement.statementType.startsWith("ALTER");
    const queryNode: LineageGraphNode = {
      id: queryNodeId,
      name: queryTitle,
      displayName: queryTitle,
      type: statement.statementType,
      role: "current_query",
      status: isDbt ? "dbt Transformation" : (isDdl ? "Active DDL" : "SQL Transformation"),
      foundInCollibra: true,
      attributes: {
        "Transformation Type": statement.statementType,
        "Target Objects": statement.targetObjects.join(", ") || "None (In-memory query result)",
        "Source Dependencies": statement.sourceObjects.join(", ") || "None",
        "Code Scope": `Lines ${statement.startLine + 1} - ${statement.endLine + 1}`,
        "Execution Dialect": statement.dialect || "SingleStore",
        "Resolution Mode": statement.origin || "active_file"
      }
    };

    // 1. Process Source Tables from Query / Manifest
    for (const src of statement.sourceObjects) {
      if (signal?.aborted) throw new Error("AbortError");
      const key = canonicalKey(src);
      let node = nodeMap.get(key);

      if (!node) {
        const collibraAsset = await this.findAsset(src, signal);
        const manifestCols = statement.columnMetadataMap?.[src] || [];
        node = {
          id: `node-${key}`,
          name: src,
          displayName: collibraAsset?.displayName || src.split(".").pop() || src,
          type: collibraAsset?.typeName || (src.includes("raw_") ? "Table" : "View"),
          role: "source",
          status: collibraAsset?.status || (collibraAsset ? "Approved" : "Not Cataloged"),
          attributes: collibraAsset?.attributes,
          columns: collibraAsset?.columns && collibraAsset.columns.length > 0 ? collibraAsset.columns : manifestCols,
          foundInCollibra: !!collibraAsset,
          collibraUrl: collibraAsset?.collibraUrl
        };
        nodeMap.set(key, node);
      } else {
        node.role = "source";
      }

      addEdge(node.id, queryNodeId, "Used in model", "query_flow");

      // Pull N levels of upstream lineage from Collibra
      const asset = await this.findAsset(src, signal);
      if (asset) {
        const lin = await this.getAssetLineageRelations(asset.id, depth, includeColumns, signal);
        for (const up of lin.upstream) {
          const upKey = canonicalKey(up.name);
          let upNode = nodeMap.get(upKey);

          if (!upNode) {
            const fullUpAsset = await this.findAsset(up.name, signal);
            upNode = {
              id: `node-${upKey}`,
              name: up.name,
              displayName: fullUpAsset?.displayName || up.name.split(".").pop() || up.name,
              type: fullUpAsset?.typeName || up.type,
              role: "catalog_upstream",
              status: fullUpAsset?.status || "Approved",
              attributes: fullUpAsset?.attributes || up.attributes || {},
              columns: fullUpAsset?.columns || up.columns || [],
              foundInCollibra: !!fullUpAsset,
              collibraUrl: fullUpAsset?.collibraUrl
            };
            nodeMap.set(upKey, upNode);
          }

          addEdge(upNode.id, node.id, "Feeds", "catalog_flow");
        }
      }
    }

    // 2. Process Target Tables
    for (const tgt of statement.targetObjects) {
      if (signal?.aborted) throw new Error("AbortError");
      const key = canonicalKey(tgt);
      let node = nodeMap.get(key);

      if (!node) {
        const collibraAsset = await this.findAsset(tgt, signal);
        const manifestCols = statement.columnMetadataMap?.[tgt] || [];
        const targetType = collibraAsset?.typeName || (statement.statementType === "CREATE_VIEW" ? "View" : "Table");
        node = {
          id: `node-${key}`,
          name: tgt,
          displayName: collibraAsset?.displayName || tgt.split(".").pop() || tgt,
          type: targetType,
          role: "target",
          status: collibraAsset?.status || (isDbt ? "dbt Model (Gold)" : "Proposed / DDL"),
          attributes: collibraAsset?.attributes || {
            "Asset Status": isDbt ? "dbt Model (Gold)" : "Proposed / DDL",
            "Target Type": targetType,
            "Target Name": tgt,
            "Defined In Query": `Lines ${statement.startLine + 1} - ${statement.endLine + 1}`,
            "Catalog Governance": collibraAsset ? "Cataloged in Collibra" : "Pending Registration"
          },
          columns: collibraAsset?.columns && collibraAsset.columns.length > 0 ? collibraAsset.columns : manifestCols,
          foundInCollibra: !!collibraAsset,
          collibraUrl: collibraAsset ? this.getAssetWebUrl(collibraAsset.id) : undefined
        };
        nodeMap.set(key, node);
      } else {
        node.role = "target";
      }

      addEdge(queryNodeId, node.id, statement.statementType === "CREATE_VIEW" ? "Defines View" : "Produces Data", "query_flow");

      // Pull N levels of downstream lineage from Collibra
      const asset = await this.findAsset(tgt, signal);
      if (asset) {
        const lin = await this.getAssetLineageRelations(asset.id, depth, includeColumns, signal);
        for (const down of lin.downstream) {
          const downKey = canonicalKey(down.name);
          let downNode = nodeMap.get(downKey);

          if (!downNode) {
            const fullDownAsset = await this.findAsset(down.name, signal);
            downNode = {
              id: `node-${downKey}`,
              name: down.name,
              displayName: fullDownAsset?.displayName || down.name.split(".").pop() || down.name,
              type: fullDownAsset?.typeName || down.type,
              role: "catalog_downstream",
              status: fullDownAsset?.status || "Approved",
              attributes: fullDownAsset?.attributes || down.attributes || {},
              columns: fullDownAsset?.columns || down.columns || [],
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
      activeConnectionId: options?.activeConnectionId || this.connection?.id,
      availableConnections: options?.availableConnections,
      settings: options?.settings,
      nodes: allNodes,
      edges,
      timestamp: Date.now(),
      manifestMissing: false,
      manifestPath: statement.resolvedFilePath
    };
  }
}

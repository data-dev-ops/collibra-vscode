export interface CollibraConnection {
  id: string;
  name: string;
  url: string;
  username: string;
  password?: string;
  apiToken?: string;
  isDefault?: boolean;
}

export type StatementType =
  | "SELECT"
  | "CREATE_TABLE_AS"
  | "CREATE_VIEW"
  | "ALTER_TABLE"
  | "INSERT"
  | "UPDATE"
  | "DELETE"
  | "DBT_MODEL"
  | "OTHER";

export interface ColumnInfo {
  id?: string;
  name: string;
  dataType?: string;
  description?: string;
}

export interface SqlStatementInfo {
  rawSql: string;
  cleanSql: string;
  startLine: number;
  endLine: number;
  statementType: StatementType;
  targetObjects: string[];
  sourceObjects: string[];
  allObjects: string[];
  origin?: "active_file" | "dbt_manifest" | "dbt_manifest_missing" | "dbt_target" | "dbt_jinja_fallback";
  resolvedFilePath?: string;
  projectType?: "pure sql" | "dbt";
  dialect?: "singlestore" | "postgres" | "mysql";
  manifestMissing?: boolean;
  manifestDetails?: {
    database?: string;
    schema?: string;
    name?: string;
    alias?: string;
    uniqueId?: string;
  };
  columnMetadataMap?: Record<string, ColumnInfo[]>;
}

export interface CollibraAttribute {
  id: string;
  name: string;
  value: string;
}

export interface CollibraAsset {
  id: string;
  name: string;
  displayName: string;
  typeName: string;
  domainId?: string;
  status?: string;
  attributes: Record<string, string>;
  columns?: ColumnInfo[];
  collibraUrl?: string;
}

export interface LineageGraphNode {
  id: string;
  name: string;
  displayName: string;
  type: string;
  role: "current_query" | "source" | "target" | "catalog_upstream" | "catalog_downstream";
  status?: string;
  attributes?: Record<string, string>;
  columns?: ColumnInfo[];
  foundInCollibra: boolean;
  collibraUrl?: string;
}

export interface LineageGraphEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  type: "query_flow" | "catalog_flow" | "column_flow";
}

export interface LineageGraphSettings {
  projectType: "pure sql" | "dbt";
  dwhBackend: "singlestore" | "postgres" | "mysql";
  depth: number;
  showColumnLevel: boolean;
  showDataTypes: boolean;
}

export interface LineageGraphData {
  statementInfo: SqlStatementInfo | null;
  activeConnectionName?: string;
  activeConnectionId?: string;
  availableConnections?: Array<{ id: string; name: string; isDefault?: boolean }>;
  settings?: LineageGraphSettings;
  nodes: LineageGraphNode[];
  edges: LineageGraphEdge[];
  timestamp: number;
  errorMessage?: string;
  manifestMissing?: boolean;
  manifestPath?: string;
}

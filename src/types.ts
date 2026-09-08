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
  | "OTHER";

export interface SqlStatementInfo {
  rawSql: string;
  cleanSql: string;
  startLine: number;
  endLine: number;
  statementType: StatementType;
  targetObjects: string[];
  sourceObjects: string[];
  allObjects: string[];
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
  foundInCollibra: boolean;
  collibraUrl?: string;
}

export interface LineageGraphEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  type: "query_flow" | "catalog_flow";
}

export interface LineageGraphData {
  statementInfo: SqlStatementInfo | null;
  activeConnectionName?: string;
  nodes: LineageGraphNode[];
  edges: LineageGraphEdge[];
  timestamp: number;
  errorMessage?: string;
}

export interface MetabaseConfig {
  url: string;
  user: string;
  pass: string;
}

export interface MetabaseRow {
  rows: any[][];
  cols: { name: string; base_type: string }[];
}

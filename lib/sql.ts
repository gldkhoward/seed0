import { parse, type Statement } from "pgsql-ast-parser";

export function parseDDL(ddl: string): Statement[] {
  return parse(ddl);
}

// MySQL 权限 SQL 生成（FR-262）。标识符白名单，避免拼进注入字符。

const ACCOUNT_USER = /^[A-Za-z0-9_$.-]+$/;
const ACCOUNT_HOST = /^[A-Za-z0-9_$.%-]+$/;
const IDENT = /^[A-Za-z0-9_]+$/;
const PRIVS = new Set([
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "CREATE",
  "DROP",
  "ALTER",
  "INDEX",
  "GRANT OPTION",
  "ALL PRIVILEGES",
]);

export function quoteMysqlAccount(user: string, host: string): string | null {
  if (!ACCOUNT_USER.test(user) || !ACCOUNT_HOST.test(host)) return null;
  return `'${user}'@'${host}'`;
}

export function buildCreateUserSql(
  user: string,
  host: string,
  password: string,
): string | null {
  const account = quoteMysqlAccount(user, host);
  if (!account || password.includes("'") || password.includes("\\") || !password) {
    return null;
  }
  return `CREATE USER ${account} IDENTIFIED BY '${password}';`;
}

export function buildDropUserSql(user: string, host: string): string | null {
  const account = quoteMysqlAccount(user, host);
  return account ? `DROP USER ${account};` : null;
}

export function buildGrantSql(
  user: string,
  host: string,
  privilege: string,
  database: string,
): string | null {
  const account = quoteMysqlAccount(user, host);
  if (!account || !PRIVS.has(privilege)) return null;
  if (database !== "*" && !IDENT.test(database)) return null;
  const scope = database === "*" ? "*.*" : `\`${database}\`.*`;
  return `GRANT ${privilege} ON ${scope} TO ${account};`;
}

export function buildRevokeSql(
  user: string,
  host: string,
  privilege: string,
  database: string,
): string | null {
  const grant = buildGrantSql(user, host, privilege, database);
  return grant ? grant.replace("GRANT ", "REVOKE ").replace(" TO ", " FROM ") : null;
}

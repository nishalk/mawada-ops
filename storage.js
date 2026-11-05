const path = require("node:path");
const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const { createClient } = require("@supabase/supabase-js");
const conflict = () =>
  Object.assign(
    new Error("This record changed or already exists. Refresh and try again."),
    { status: 409 },
  );
function privilegedKey(key) {
  if (typeof key !== "string") return false;
  if (key.startsWith("sb_secret_")) return true;
  try {
    return (
      JSON.parse(Buffer.from(key.split(".")[1], "base64url")).role ===
      "service_role"
    );
  } catch {
    return false;
  }
}
function createStorage(env = process.env, clientOverride) {
  const backend = env.DATABASE_BACKEND || "sqlite";
  if (backend === "sqlite") {
    const dir = env.DATA_DIR || path.resolve("data");
    if (!path.isAbsolute(dir))
      throw Error("DATA_DIR must be an absolute directory");
    fs.mkdirSync(dir, { recursive: true });
    const db = new DatabaseSync(path.join(dir, "app.db"));
    db.exec(
      "CREATE TABLE IF NOT EXISTS records (kind TEXT, id TEXT, body TEXT, PRIMARY KEY(kind,id))",
    );
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS relay_users_email ON records(lower(json_extract(body,'$.email'))) WHERE kind='users';
      CREATE UNIQUE INDEX IF NOT EXISTS relay_vendor_code ON records(json_extract(body,'$.code')) WHERE kind='vendors';
      CREATE UNIQUE INDEX IF NOT EXISTS relay_order_reference ON records(json_extract(body,'$.reference')) WHERE kind='orders';
    `);
    const store = {
      backend,
      async all(kind) {
        return db
          .prepare("SELECT body FROM records WHERE kind=? ORDER BY id")
          .all(kind)
          .map((r) => {
            const b = JSON.parse(r.body);
            return { ...b, _revision: b._revision ?? 0 };
          });
      },
      async get(kind, id) {
        const r = db
          .prepare("SELECT body FROM records WHERE kind=? AND id=?")
          .get(kind, id ?? "");
        if (!r) return undefined;
        const b = JSON.parse(r.body);
        return { ...b, _revision: b._revision ?? 0 };
      },
      async save(kind, body) {
        const existing = Object.hasOwn(body, "_revision");
        const result = {
          ...body,
          _revision: existing ? body._revision + 1 : 1,
        };
        if (existing) {
          const r = db
            .prepare(
              "UPDATE records SET body=? WHERE kind=? AND id=? AND COALESCE(json_extract(body,'$._revision'),0)=?",
            )
            .run(JSON.stringify(result), kind, body.id, body._revision);
          if (!r.changes) throw conflict();
        } else {
          try {
            db.prepare("INSERT INTO records VALUES (?,?,?)").run(
              kind,
              body.id,
              JSON.stringify(result),
            );
          } catch (e) {
            if (e.code?.includes("CONSTRAINT")) throw conflict();
            throw e;
          }
        }
        return result;
      },
      async insertMany(kind, bodies) {
        db.exec("BEGIN");
        try {
          for (const b of bodies) await store.save(kind, b);
          db.exec("COMMIT");
        } catch (e) {
          db.exec("ROLLBACK");
          throw e;
        }
      },
      close() {
        db.close();
      },
    };
    return store;
  }
  if (backend !== "supabase")
    throw Error("DATABASE_BACKEND must be sqlite or supabase");
  const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_API_KEY;
  if (!env.SUPABASE_URL || !privilegedKey(key))
    throw Error(
      "Supabase requires SUPABASE_URL and a server-only service-role or secret API key",
    );
  const url = new URL(env.SUPABASE_URL);
  if (url.protocol !== "https:" && !clientOverride)
    throw Error("SUPABASE_URL must use HTTPS");
  const client =
    clientOverride ||
    createClient(env.SUPABASE_URL, key, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        fetch: (url, options) =>
          fetch(url, { ...options, signal: AbortSignal.timeout(15000) }),
      },
    });
  function checked(result) {
    if (result.error) {
      if (result.error.code === "23505") throw conflict();
      const code = result.error.code;
      const databaseCode =
        typeof code === "string" &&
        /^(?:[0-9A-Z]{5}|PGRST[0-9A-Z]{3})$/.test(code)
          ? code
          : undefined;
      let reason = "SUPABASE_REQUEST_FAILED",
        message =
          "Supabase could not confirm this request. Refresh the order before retrying.";
      if (code === "42501" || [401, 403].includes(result.status)) {
        reason = "SUPABASE_ACCESS_DENIED";
        message =
          "Supabase denied this request. The administrator must check the server credential and table permissions.";
      } else if (["42P01", "42703", "PGRST204", "PGRST205"].includes(code)) {
        reason = "SUPABASE_SCHEMA_MISMATCH";
        message =
          "Supabase reports a missing table or column. The administrator must check the configured delivery schema.";
      } else if (["23514", "23502", "22P02"].includes(code)) {
        reason = "SUPABASE_RECORD_REJECTED";
        message =
          "Supabase rejected this record’s format or constraints. The administrator must inspect the database validation error.";
      } else if (
        code === "57014" ||
        code === "PGRST003" ||
        result.status === 504
      ) {
        reason = "SUPABASE_TIMEOUT";
        message =
          "The Supabase request timed out. Refresh to check whether the assignment was saved before retrying.";
      } else if (result.status === 0 || !code) {
        reason = "SUPABASE_CONNECTION_FAILED";
        message =
          "The app could not confirm a response from Supabase. Check the refreshed order before retrying.";
      }
      throw Object.assign(
        new Error(
          message +
            (databaseCode ? " (database code " + databaseCode + ")" : ""),
        ),
        { status: 503, code: reason, databaseCode },
      );
    }
    return result.data;
  }
  const decode = (r) => ({ ...r.body, _revision: r.revision });
  const encode = (body) => {
    const { _revision, ...b } = body;
    return b;
  };
  return {
    backend,
    async all(kind) {
      const rows = [];
      for (let offset = 0; ; offset += 100) {
        const page = checked(
          await client
            .from("delivery_records")
            .select("body,revision")
            .eq("kind", kind)
            .order("id")
            .range(offset, offset + 99),
        );
        rows.push(...page.map(decode));
        if (page.length < 100) return rows;
      }
    },
    async get(kind, id) {
      if (!id) return undefined;
      const r = checked(
        await client
          .from("delivery_records")
          .select("body,revision")
          .eq("kind", kind)
          .eq("id", id)
          .maybeSingle(),
      );
      return r ? decode(r) : undefined;
    },
    async save(kind, body) {
      const revision = body._revision;
      const query = Object.hasOwn(body, "_revision")
        ? client
            .from("delivery_records")
            .update({ body: encode(body), revision: revision + 1 })
            .eq("kind", kind)
            .eq("id", body.id)
            .eq("revision", revision)
        : client
            .from("delivery_records")
            .insert({ kind, id: body.id, body: encode(body) });
      // Confirm the revision without downloading proof images again after every save.
      const rows = checked(await query.select("revision"));
      if (rows.length !== 1) throw conflict();
      return { ...body, _revision: rows[0].revision };
    },
    async insertMany(kind, bodies) {
      if (bodies.length)
        checked(
          await client
            .from("delivery_records")
            .insert(bodies.map((b) => ({ kind, id: b.id, body: encode(b) }))),
        );
    },
    close() {},
  };
}
module.exports = { createStorage, privilegedKey };

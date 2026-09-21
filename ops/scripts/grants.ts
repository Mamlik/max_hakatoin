import pg from 'pg';
import { config } from '../../packages/backend/config.js';
const db=new pg.Client({connectionString:process.env.MIGRATION_DATABASE_URL??config.DATABASE_URL});
try{await db.connect();await db.query('GRANT USAGE ON SCHEMA public TO salon_runtime; GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO salon_runtime; GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO salon_runtime; REVOKE UPDATE, DELETE ON audit_log, consent_history, booking_revisions, voucher_revisions, delivery_attempts FROM salon_runtime; REVOKE INSERT, UPDATE, DELETE ON schema_migrations FROM salon_runtime;');console.log('Runtime database privileges applied');}finally{await db.end();}

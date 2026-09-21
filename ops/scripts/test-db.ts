import pg from 'pg';
import 'dotenv/config';
const target=new URL(process.env.TEST_DATABASE_URL??'postgres://salon:salon_local_only@localhost:5432/salon_test');
const name=target.pathname.slice(1);
if(!/^[a-zA-Z0-9_]+_test$/.test(name))throw new Error('Test database name must end in _test');
target.pathname='/postgres';
const db=new pg.Client({connectionString:target.toString()});
try {
  await db.connect();
  if(!(await db.query('SELECT 1 FROM pg_database WHERE datname=$1',[name])).rowCount)await db.query(`CREATE DATABASE "${name}"`);
  console.log(`Test database ready: ${name}. Tests reset only this database.`);
} finally {await db.end();}

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_DB_URL,
  process.env.SUPABASE_DB_PASSWORD
);

export default supabase;
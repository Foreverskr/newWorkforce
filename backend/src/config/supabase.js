import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || supabaseUrl.includes('your-project-id')) {
  console.error('\n❌  SUPABASE_URL is not set in your .env file!');
  console.error('   Copy .env.example → .env and fill in your Supabase credentials.\n');
  process.exit(1);
}

if (!supabaseKey || supabaseKey === 'your-service-role-key') {
  console.error('\n❌  SUPABASE_SERVICE_ROLE_KEY is not set in your .env file!');
  console.error('   Go to Supabase Dashboard → Settings → API → service_role key\n');
  process.exit(1);
}

export const supabase = createClient(supabaseUrl, supabaseKey);

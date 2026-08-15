import { config } from 'dotenv';

// Load .env.vars into process.env. This module is imported FIRST in the server
// because ES module imports are evaluated before top-level statements.
config({ path: '.env.vars' });

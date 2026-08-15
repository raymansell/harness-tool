import { openai } from '@ai-sdk/openai';

// The one place the model is configured.
// The provider reads OPENAI_API_KEY from the environment at request time
// (the server loads it from .env.vars on startup).
export const model = openai(process.env.OPENAI_MODEL ?? 'gpt-5.6-luna');

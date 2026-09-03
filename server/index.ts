import { createApp } from './app';
import { createDb, createPool } from './db/pool';

const PORT = Number(process.env.PORT ?? 3001);

createApp(createDb(createPool())).listen(PORT, () => {
  console.log(`invest-buddy api listening on http://localhost:${PORT}`);
});

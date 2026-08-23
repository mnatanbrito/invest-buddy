import { createApp } from './app';
import { createPool } from './db/pool';

const PORT = Number(process.env.PORT ?? 3001);

createApp(createPool()).listen(PORT, () => {
  console.log(`invest-buddy api listening on http://localhost:${PORT}`);
});

// JSON 파일 저장소 (로컬 개발, docker run). DATA_DIR/recipes.json 하나에 모든 항목을 둔다.
// 쓰기는 한 줄로 세워(직렬화) 동시 쓰기로 파일이 깨지지 않게 하고, 임시 파일에 쓴 뒤 rename으로 바꿔 넣는다.
// 프로세스 하나에서만 써야 한다. 여러 복제본(ACA)에서는 cosmos 드라이버를 쓴다.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { compareNewestFirst, decodeCursor, encodeCursor, toListItem } from './order.js';

export async function createFileStorage({ dataDir }) {
  await mkdir(dataDir, { recursive: true });
  const file = join(dataDir, 'recipes.json');
  const usersFile = join(dataDir, 'users.json');
  let entries = await load(file);
  let users = await load(usersFile);
  let queue = Promise.resolve();

  // 쓰기 작업을 순서대로 실행한다. 실패해도 다음 작업은 계속 실행된다.
  function serialize(task) {
    const run = queue.then(task);
    queue = run.catch(() => {});
    return run;
  }

  async function writeJson(path, data) {
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(data));
    await rename(tmp, path);
  }

  async function persist(next) {
    await writeJson(file, next);
    entries = next;
  }

  const owned = (clientId) => entries.filter((e) => e.clientId === clientId);

  return {
    driver: 'file',

    save: (clientId, entry) => serialize(async () => {
      const existing = entries.find((e) => e.clientId === clientId && e.id === entry.id);
      if (existing) return { entry: existing, created: false };
      await persist([...entries, entry]);
      return { entry, created: true };
    }),

    async list(clientId, { cursor, limit }) {
      const sorted = owned(clientId).sort(compareNewestFirst);
      const after = decodeCursor(cursor);
      const start = after ? sorted.findIndex((e) => compareNewestFirst(e, after) > 0) : 0;
      const page = start === -1 ? [] : sorted.slice(start, start + limit);
      const hasMore = start !== -1 && start + limit < sorted.length;
      return { items: page.map(toListItem), nextCursor: hasMore ? encodeCursor(page.at(-1)) : null };
    },

    async get(clientId, id) {
      return entries.find((e) => e.clientId === clientId && e.id === id) ?? null;
    },

    remove: (clientId, id) => serialize(async () => {
      const next = entries.filter((e) => !(e.clientId === clientId && e.id === id));
      if (next.length === entries.length) return false;
      await persist(next);
      return true;
    }),

    async count(clientId) {
      return owned(clientId).length;
    },

    users: {
      create: (user) => serialize(async () => {
        const existing = users.find((u) => u.id === user.id);
        if (existing) return { user: existing, created: false };
        const next = [...users, user];
        await writeJson(usersFile, next);
        users = next;
        return { user, created: true };
      }),
      async findByEmail(email) {
        return users.find((u) => u.id === email) ?? null;
      },
    },
  };
}

async function load(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw new Error(`저장 파일을 읽을 수 없습니다: ${file} (${err.message})`);
  }
}

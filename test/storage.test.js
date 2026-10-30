// 저장소 계약 테스트: 모든 드라이버가 같은 동작을 해야 한다.
// - file: 항상 실행 (임시 폴더)
// - cosmos: COSMOS_TEST_ENDPOINT, COSMOS_TEST_KEY가 있을 때만 실행 (Cosmos DB 에뮬레이터 등)
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createStorage } from '../src/storage/index.js';

const entry = (clientId, savedAt, id = randomUUID()) => ({
  id,
  clientId,
  savedAt,
  ownedIngredients: ['달걀'],
  recipe: { id, title: `레시피 ${savedAt}`, summary: '요약', timeMinutes: 15, difficulty: '쉬움', steps: ['굽는다.'] },
  schemaVersion: 1,
});

function contract(name, setup) {
  describe(`저장소 계약: ${name}`, () => {
    let storage;
    let cleanup;
    // 실행마다 새 clientId → 공유 DB(cosmos)에서도 서로 섞이지 않는다
    const alice = randomUUID();
    const bob = randomUUID();

    before(async () => {
      ({ storage, cleanup } = await setup());
    });
    after(async () => {
      for (const clientId of [alice, bob]) {
        let page = await storage.list(clientId, { limit: 100 });
        for (const e of page.items) await storage.remove(clientId, e.id);
      }
      await cleanup?.();
    });

    test('저장 → 같은 id 다시 저장하면 기존 항목 (created=false)', async () => {
      const e = entry(alice, '2026-10-30T01:00:00.000Z');
      const first = await storage.save(alice, e);
      assert.equal(first.created, true);
      assert.deepEqual(first.entry, e);
      const again = await storage.save(alice, { ...e, savedAt: '2026-10-30T09:00:00.000Z' });
      assert.equal(again.created, false);
      assert.equal(again.entry.savedAt, e.savedAt, '처음 저장한 항목을 돌려준다');
      assert.deepEqual(await storage.get(alice, e.id), e);
    });

    test('다른 clientId의 항목은 없는 것처럼 동작한다', async () => {
      const e = entry(alice, '2026-10-30T02:00:00.000Z');
      await storage.save(alice, e);
      assert.equal(await storage.get(bob, e.id), null);
      assert.equal(await storage.remove(bob, e.id), false);
      assert.deepEqual((await storage.list(bob, { limit: 20 })).items, []);
      assert.equal(await storage.count(bob), 0);
      assert.ok(await storage.get(alice, e.id), '남의 삭제 시도 후에도 남아 있다');
    });

    test('목록: 최신순(같은 시각이면 id 내림차순), 커서로 끝까지 넘긴다', async () => {
      const client = randomUUID();
      const sameTime = '2026-10-30T05:00:00.000Z';
      const saved = [
        entry(client, '2026-10-30T03:00:00.000Z'),
        entry(client, '2026-10-30T07:00:00.000Z'),
        entry(client, sameTime, 'aaaaaaaa-0000-4000-8000-000000000001'),
        entry(client, sameTime, 'ffffffff-0000-4000-8000-000000000002'),
        entry(client, '2026-10-30T06:00:00.000Z'),
      ];
      for (const e of saved) await storage.save(client, e);
      const expected = ['2026-10-30T07:00:00.000Z', '2026-10-30T06:00:00.000Z', 'ffff', 'aaaa', '2026-10-30T03:00:00.000Z'];

      const seen = [];
      let cursor;
      let pages = 0;
      do {
        const page = await storage.list(client, { cursor, limit: 2 });
        assert.ok(page.items.length <= 2);
        seen.push(...page.items);
        cursor = page.nextCursor;
        pages++;
      } while (cursor && pages < 10);

      assert.deepEqual(seen.map((e) => (e.savedAt === sameTime ? e.id.slice(0, 4) : e.savedAt)), expected);
      assert.equal(await storage.count(client), 5);
      for (const e of saved) await storage.remove(client, e.id);
    });

    test('목록 항목은 요약 필드만 (본문·소유자 ID 없이, 같은 필드 순서)', async () => {
      const client = randomUUID();
      const e = entry(client, '2026-10-30T08:00:00.000Z');
      await storage.save(client, e);
      const { items } = await storage.list(client, { limit: 20 });
      assert.deepEqual(items, [{ id: e.id, title: e.recipe.title, summary: '요약', timeMinutes: 15, difficulty: '쉬움', savedAt: e.savedAt }]);
      assert.deepEqual(Object.keys(items[0]), ['id', 'title', 'summary', 'timeMinutes', 'difficulty', 'savedAt']);
      await storage.remove(client, e.id);
    });

    test('삭제: 한 번만 true, 이후 get은 null', async () => {
      const e = entry(alice, '2026-10-30T04:00:00.000Z');
      await storage.save(alice, e);
      const before = await storage.count(alice);
      assert.equal(await storage.remove(alice, e.id), true);
      assert.equal(await storage.remove(alice, e.id), false);
      assert.equal(await storage.get(alice, e.id), null);
      assert.equal(await storage.count(alice), before - 1);
    });

    test('사용자: 만들기 → 이메일로 찾기, 같은 이메일은 created=false', async () => {
      const email = `${randomUUID()}@test.dev`;
      const user = { id: email, userId: randomUUID(), email, passwordHash: 'scrypt$x', createdAt: '2026-10-30T00:00:00.000Z' };
      const first = await storage.users.create(user);
      assert.equal(first.created, true);
      assert.deepEqual(await storage.users.findByEmail(email), user);
      const again = await storage.users.create({ ...user, userId: randomUUID(), passwordHash: 'scrypt$y' });
      assert.equal(again.created, false);
      assert.equal(again.user.userId, user.userId, '처음 가입한 사용자를 돌려준다');
      assert.equal(await storage.users.findByEmail(`${randomUUID()}@test.dev`), null);
    });

    test('동시에 여러 개 저장해도 모두 남는다', async () => {
      const client = randomUUID();
      const many = Array.from({ length: 10 }, (_, i) => entry(client, `2026-10-30T10:00:0${i}.000Z`));
      await Promise.all(many.map((e) => storage.save(client, e)));
      assert.equal(await storage.count(client), 10);
      for (const e of many) await storage.remove(client, e.id);
    });
  });
}

let dataDir;
contract('file', async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'fridge-chef-'));
  return {
    storage: await createStorage({ driver: 'file', dataDir }),
    cleanup: () => rm(dataDir, { recursive: true, force: true }),
  };
});

test('file 드라이버: 다시 시작해도 파일에서 읽어 온다', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fridge-chef-'));
  try {
    const client = randomUUID();
    const e = entry(client, '2026-10-30T01:00:00.000Z');
    await (await createStorage({ driver: 'file', dataDir: dir })).save(client, e);
    const reopened = await createStorage({ driver: 'file', dataDir: dir });
    assert.deepEqual(await reopened.get(client, e.id), e);
    assert.equal(JSON.parse(await readFile(join(dir, 'recipes.json'), 'utf8')).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

if (process.env.COSMOS_TEST_ENDPOINT && process.env.COSMOS_TEST_KEY) {
  contract('cosmos', async () => ({
    storage: await createStorage({
      driver: 'cosmos',
      cosmos: {
        endpoint: process.env.COSMOS_TEST_ENDPOINT,
        key: process.env.COSMOS_TEST_KEY,
        database: process.env.COSMOS_TEST_DATABASE ?? 'fridge-chef',
        container: process.env.COSMOS_TEST_CONTAINER ?? 'recipes',
      },
    }),
  }));
}

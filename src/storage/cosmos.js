// Azure Cosmos DB for NoSQL 저장소 (ACA 운영)
// - 파티션 키: /clientId → 한 사용자의 조회·삭제가 한 파티션 안에서 끝난다
// - 인증: 기본은 관리 ID(DefaultAzureCredential). Cosmos 에뮬레이터 등에서는 COSMOS_KEY로 키 인증
// - DB와 컨테이너는 인프라(infra/main.bicep)가 미리 만든다. 데이터 역할(RBAC)로는 만들 수 없기 때문이다.
// - 목록 정렬(savedAt DESC, id DESC)에는 복합 인덱스가 필요하다 (main.bicep에 정의)
import { CosmosClient } from '@azure/cosmos';
import { DefaultAzureCredential } from '@azure/identity';
import { decodeCursor, encodeCursor } from './order.js';

// 목록은 요약 필드만 읽는다 (order.js toListItem과 같은 필드·순서). 본문 전체(SELECT *)보다 응답이 약 1/10이다.
const LIST_FIELDS = 'c.id, c.recipe.title, c.recipe.summary, c.recipe.timeMinutes, c.recipe.difficulty, c.savedAt';

export async function createCosmosStorage({ endpoint, database, container: containerName, usersContainer: usersName = 'users', key }) {
  if (!endpoint) throw new Error('STORAGE_DRIVER=cosmos에는 COSMOS_ENDPOINT가 필요합니다.');
  const client = new CosmosClient(key ? { endpoint, key } : { endpoint, aadCredentials: new DefaultAzureCredential() });
  const container = client.database(database).container(containerName);
  // 사용자: id와 파티션 키(/id)가 정규화한 이메일 → 이메일로 바로 읽는다(point read)
  const usersContainer = client.database(database).container(usersName);
  // 시작할 때 연결과 권한을 확인한다 (잘못된 설정이면 첫 요청이 아니라 시작 시점에 실패)
  await Promise.all([container.read(), usersContainer.read()]);

  const isNotFound = (err) => err?.code === 404 || err?.statusCode === 404;

  async function get(clientId, id) {
    try {
      const { resource } = await container.item(id, clientId).read();
      return resource ? strip(resource) : null;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  return {
    driver: 'cosmos',

    async save(clientId, entry) {
      try {
        const { resource } = await container.items.create(entry);
        return { entry: strip(resource), created: true };
      } catch (err) {
        // 같은 id가 이미 있음 (다시 저장, 동시 저장) → 기존 항목을 돌려준다
        if (err?.code === 409) return { entry: await get(clientId, entry.id), created: false };
        throw err;
      }
    },

    // Cosmos의 continuationToken 대신 (savedAt, id) 커서로 직접 넘긴다.
    // file 드라이버와 커서 형식이 같고, 에뮬레이터처럼 ORDER BY 쿼리에서 페이지 크기를 무시하는 환경에서도 똑같이 동작한다.
    async list(clientId, { cursor, limit }) {
      const after = decodeCursor(cursor);
      const parameters = [{ name: '@clientId', value: clientId }, { name: '@take', value: limit + 1 }];
      let where = 'c.clientId = @clientId';
      if (after) {
        where += ' AND (c.savedAt < @savedAt OR (c.savedAt = @savedAt AND c.id < @id))';
        parameters.push({ name: '@savedAt', value: after.savedAt }, { name: '@id', value: after.id });
      }
      const { resources } = await container.items
        .query({ query: `SELECT TOP @take ${LIST_FIELDS} FROM c WHERE ${where} ORDER BY c.savedAt DESC, c.id DESC`, parameters }, { partitionKey: clientId })
        .fetchAll();
      const items = resources.slice(0, limit);
      return { items, nextCursor: resources.length > limit ? encodeCursor(items.at(-1)) : null };
    },

    get,

    async remove(clientId, id) {
      try {
        await container.item(id, clientId).delete();
        return true;
      } catch (err) {
        if (isNotFound(err)) return false;
        throw err;
      }
    },

    async count(clientId) {
      const { resources } = await container.items
        .query(
          { query: 'SELECT VALUE COUNT(1) FROM c WHERE c.clientId = @clientId', parameters: [{ name: '@clientId', value: clientId }] },
          { partitionKey: clientId },
        )
        .fetchAll();
      return resources[0] ?? 0;
    },

    users: {
      async create(user) {
        try {
          const { resource } = await usersContainer.items.create(user);
          return { user: strip(resource), created: true };
        } catch (err) {
          if (err?.code === 409) return { user: await findUser(user.id), created: false };
          throw err;
        }
      },
      findByEmail: (email) => findUser(email),
    },
  };

  async function findUser(email) {
    try {
      const { resource } = await usersContainer.item(email, email).read();
      return resource ? strip(resource) : null;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }
}

// Cosmos 시스템 필드(_rid, _etag, _ts 등)는 API 응답에 내보내지 않는다
function strip(resource) {
  return Object.fromEntries(Object.entries(resource).filter(([k]) => !k.startsWith('_')));
}

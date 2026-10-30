// 로컬 Cosmos DB 에뮬레이터에 DB·컨테이너를 만든다 (운영은 infra/main.bicep이 만든다. 설정을 같게 유지할 것)
//   docker run -d --name cosmos-emu -p 8081:8081 mcr.microsoft.com/cosmosdb/linux/azure-cosmos-emulator:vnext-preview --protocol http
//   node scripts/cosmos-emulator-setup.js
// 에뮬레이터 키는 Microsoft 문서에 공개된 고정값이다 (실제 계정 키 아님).
import { CosmosClient } from '@azure/cosmos';

export const EMULATOR = {
  endpoint: process.env.COSMOS_TEST_ENDPOINT ?? 'http://localhost:8081',
  key: process.env.COSMOS_TEST_KEY ?? 'C2y6yDjf5/R+ob0N8A7Cgv30VRDJIWEHLM+4QDU5DE2nQ9nDuVTqobD4b8mGGyPMbIZnqyMsEcaGQy67XIw/Jw==',
};

const client = new CosmosClient(EMULATOR);
const { database } = await client.databases.createIfNotExists({ id: 'fridge-chef' });
const { container } = await database.containers.createIfNotExists({
  id: 'recipes',
  partitionKey: { paths: ['/clientId'] },
  indexingPolicy: {
    indexingMode: 'consistent',
    includedPaths: [{ path: '/*' }],
    excludedPaths: [{ path: '/recipe/*' }, { path: '/ownedIngredients/*' }, { path: '/"_etag"/?' }],
    compositeIndexes: [[{ path: '/savedAt', order: 'descending' }, { path: '/id', order: 'descending' }]],
  },
});
// 사용자: id = 파티션 키 = 정규화한 이메일. id로만 읽으므로 색인하지 않는다 (main.bicep과 같게)
const { container: users } = await database.containers.createIfNotExists({
  id: 'users',
  partitionKey: { paths: ['/id'] },
  indexingPolicy: { indexingMode: 'consistent', includedPaths: [], excludedPaths: [{ path: '/*' }] },
});
console.log(`준비 완료: ${EMULATOR.endpoint} / fridge-chef / ${container.id}, ${users.id}`);

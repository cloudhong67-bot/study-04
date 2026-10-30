// 냉장고를 부탁해 (fridge-chef) - Azure 리소스 (PRD_step3.md 10장)
// 배포: infra/deploy.sh (1차: deployApp=false로 기반 리소스 → 이미지 빌드 → 2차: deployApp=true로 앱)
//
// 보안 원칙
// - API 키(OpenRouter)와 세션 서명 키는 Container App secret으로만 넣는다
// - ACR 이미지 받기와 Cosmos DB 접근은 사용자 할당 관리 ID로 한다 (ACR admin 계정, Cosmos 키 사용 안 함)

@description('리소스 이름 앞부분 (소문자, 숫자)')
@minLength(3)
@maxLength(12)
param prefix string = 'fridgechef'

param location string = resourceGroup().location

@description('false면 기반 리소스만 만든다 (이미지를 올리기 전 1차 배포)')
param deployApp bool = true

@description('배포할 컨테이너 이미지 (예: <acr>.azurecr.io/fridge-chef:<tag>)')
param containerImage string = ''

@secure()
@description('OpenRouter API 키 → Container App secret')
param openRouterApiKey string = ''

@secure()
@description('로그인 세션 쿠키 서명 키(32자 이상) → Container App secret. 바꾸면 모든 사용자가 로그아웃된다')
param sessionSecret string = ''

param aiModel string = 'nvidia/nemotron-3.5-super-vl:free'

@description('모델 내부 추론 off(빠름) / on')
@allowed(['off', 'on'])
param openRouterReasoning string = 'off'

@minValue(0)
param minReplicas int = 0
@minValue(1)
param maxReplicas int = 2

var suffix = take(uniqueString(resourceGroup().id), 6)
var databaseName = 'fridge-chef'
var containerName = 'recipes'
var usersContainerName = 'users'
var acrPullRoleId = '7f951dda-4ed3-4680-a7ca-43fe172d538d'
// Cosmos DB 기본 제공 데이터 기여자 (데이터 평면 RBAC)
var cosmosDataContributorRoleId = '00000000-0000-0000-0000-000000000002'

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${prefix}-logs-${suffix}'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${prefix}-id-${suffix}'
  location: location
}

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: '${prefix}acr${suffix}'
  location: location
  sku: { name: 'Basic' }
  properties: {
    adminUserEnabled: false
  }
}

resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(acr.id, identity.id, acrPullRoleId)
  scope: acr
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleId)
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource cosmos 'Microsoft.DocumentDB/databaseAccounts@2024-05-15' = {
  name: '${prefix}-cosmos-${suffix}'
  location: location
  kind: 'GlobalDocumentDB'
  properties: {
    databaseAccountOfferType: 'Standard'
    capabilities: [{ name: 'EnableServerless' }]
    consistencyPolicy: { defaultConsistencyLevel: 'Session' }
    locations: [{ locationName: location, failoverPriority: 0, isZoneRedundant: false }]
    disableLocalAuth: true // 키 인증 끔: 관리 ID(RBAC)로만 접근
    minimalTlsVersion: 'Tls12'
  }
}

resource database 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases@2024-05-15' = {
  parent: cosmos
  name: databaseName
  properties: {
    resource: { id: databaseName }
  }
}

// scripts/cosmos-emulator-setup.js와 같은 설정을 유지할 것
resource recipes 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-05-15' = {
  parent: database
  name: containerName
  properties: {
    resource: {
      id: containerName
      partitionKey: { paths: ['/clientId'], kind: 'Hash' }
      indexingPolicy: {
        indexingMode: 'consistent'
        includedPaths: [{ path: '/*' }]
        excludedPaths: [{ path: '/recipe/*' }, { path: '/ownedIngredients/*' }, { path: '/"_etag"/?' }]
        // 목록 정렬: ORDER BY c.savedAt DESC, c.id DESC (src/storage/cosmos.js)
        compositeIndexes: [
          [
            { path: '/savedAt', order: 'descending' }
            { path: '/id', order: 'descending' }
          ]
        ]
      }
    }
  }
}

// 사용자: id = 파티션 키 = 정규화한 이메일 (src/storage/cosmos.js). 비밀번호는 scrypt 해시만 저장
resource users 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-05-15' = {
  parent: database
  name: usersContainerName
  properties: {
    resource: {
      id: usersContainerName
      partitionKey: { paths: ['/id'], kind: 'Hash' }
      // 사용자 문서는 id로만 읽고(point read) 쿼리하지 않으므로 색인하지 않는다 → 쓰기 RU·저장 공간 절약
      indexingPolicy: {
        indexingMode: 'consistent'
        includedPaths: []
        excludedPaths: [{ path: '/*' }]
      }
    }
  }
}

resource cosmosDataRole 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-05-15' = {
  parent: cosmos
  name: guid(cosmos.id, identity.id, cosmosDataContributorRoleId)
  properties: {
    roleDefinitionId: '${cosmos.id}/sqlRoleDefinitions/${cosmosDataContributorRoleId}'
    principalId: identity.properties.principalId
    scope: cosmos.id
  }
}

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${prefix}-env-${suffix}'
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
  }
}

resource app 'Microsoft.App/containerApps@2024-03-01' = if (deployApp) {
  name: '${prefix}-app'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${identity.id}': {} }
  }
  dependsOn: [acrPull, cosmosDataRole, recipes, users]
  properties: {
    managedEnvironmentId: environment.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 8080
        transport: 'auto'
        allowInsecure: false
      }
      registries: [{ server: acr.properties.loginServer, identity: identity.id }]
      secrets: [
        { name: 'openrouter-api-key', value: openRouterApiKey }
        { name: 'session-secret', value: sessionSecret }
      ]
    }
    template: {
      containers: [
        {
          name: 'fridge-chef'
          image: containerImage
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: [
            { name: 'OPENROUTER_API_KEY', secretRef: 'openrouter-api-key' }
            { name: 'SESSION_SECRET', secretRef: 'session-secret' }
            { name: 'AI_MODEL', value: aiModel }
            { name: 'OPENROUTER_REASONING', value: openRouterReasoning }
            { name: 'STORAGE_DRIVER', value: 'cosmos' }
            { name: 'COSMOS_ENDPOINT', value: cosmos.properties.documentEndpoint }
            { name: 'COSMOS_DATABASE', value: databaseName }
            { name: 'COSMOS_CONTAINER', value: containerName }
            { name: 'COSMOS_USERS_CONTAINER', value: usersContainerName }
            // DefaultAzureCredential이 사용자 할당 관리 ID를 고르게 한다
            { name: 'AZURE_CLIENT_ID', value: identity.properties.clientId }
          ]
          probes: [
            { type: 'Liveness', httpGet: { path: '/healthz', port: 8080 }, periodSeconds: 30 }
            { type: 'Readiness', httpGet: { path: '/healthz', port: 8080 }, periodSeconds: 10 }
          ]
        }
      ]
      scale: { minReplicas: minReplicas, maxReplicas: maxReplicas }
    }
  }
}

output acrName string = acr.name
output acrLoginServer string = acr.properties.loginServer
output cosmosEndpoint string = cosmos.properties.documentEndpoint
output containerAppName string = '${prefix}-app'
output appUrl string = deployApp ? 'https://${app!.properties.configuration.ingress.fqdn}' : ''

import { mockClient } from 'aws-sdk-client-mock';
import { BatchGetCommand } from '@aws-sdk/lib-dynamodb';
import { batchGetAll, ddb, TABLE_NAME } from '../../src/lib/dynamo';

const ddbMock = mockClient(ddb);

describe('batchGetAll', () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  it('re-sends unprocessed keys until every key is answered', async () => {
    const keys = [
      { PK: 'PLACE#1', SK: 'METADATA' },
      { PK: 'PLACE#2', SK: 'METADATA' },
    ];
    ddbMock
      .on(BatchGetCommand)
      .resolvesOnce({
        Responses: { [TABLE_NAME]: [{ id: '1' }] },
        UnprocessedKeys: { [TABLE_NAME]: { Keys: [keys[1]] } },
      })
      .resolvesOnce({ Responses: { [TABLE_NAME]: [{ id: '2' }] } });

    const items = await batchGetAll(keys);

    expect(items).toEqual([{ id: '1' }, { id: '2' }]);
    const calls = ddbMock.commandCalls(BatchGetCommand);
    expect(calls).toHaveLength(2);
    expect(calls[1].args[0].input.RequestItems?.[TABLE_NAME].Keys).toEqual([keys[1]]);
  });
});

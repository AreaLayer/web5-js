import type { BatchOperation } from 'level';
import type {
  EventsGetReply,
  MessagesGetReply,
  RecordsReadReply,
  RecordsWriteMessage,
} from '@tbd54566975/dwn-sdk-js';

import { Level } from 'level';
import { Convert } from '@web5/common';
import { utils as didUtils } from '@web5/dids';
import { DataStream } from '@tbd54566975/dwn-sdk-js';

import type { Web5ManagedAgent } from './types/agent.js';

import { webReadableToIsomorphicNodeReadable } from './utils.js';

export interface SyncManager {
  registerIdentity(options: { did: string }): Promise<void>;
  push(): Promise<void>;
  pull(): Promise<void>;
}

export type SyncManagerOptions = {
  agent: Web5ManagedAgent;
  dataPath?: string;
};

type SyncDirection = 'push' | 'pull';

type SyncState = {
  did: string;
  dwnUrl: string;
  watermark: string | undefined;
}

type DwnMessage = {
  message: any;
  data?: Blob;
}

type DbBatchOperation = BatchOperation<Level, string, string>;

const is2xx = (code: number) => code >= 200 && code <= 299;
const is4xx = (code: number) => code >= 400 && code <= 499;
// const is5xx = (code: number) => code >= 500 && code <= 599;

export class SyncManagerLevel implements SyncManager {
  /**
   * Holds the instance of a `Web5ManagedAgent` that represents the current
   * execution context for the `KeyManager`. This agent is utilized
   * to interact with other Web5 agent components. It's vital
   * to ensure this instance is set to correctly contextualize
   * operations within the broader Web5 agent framework.
   */
  private _agent?: Web5ManagedAgent;
  private _db: Level;

  constructor(options?: SyncManagerOptions) {
    let { agent, dataPath = 'DATA/AGENT/SYNC_STORE' } = options ?? {};

    this._agent = agent;
    this._db = new Level(dataPath);
  }

  /**
   * Retrieves the `Web5ManagedAgent` execution context.
   * If the `agent` instance proprety is undefined, it will throw an error.
   *
   * @returns The `Web5ManagedAgent` instance that represents the current execution
   * context.
   *
   * @throws Will throw an error if the `agent` instance property is undefined.
   */
  get agent(): Web5ManagedAgent {
    if (this._agent === undefined) {
      throw new Error('DidManager: Unable to determine agent execution context.');
    }

    return this._agent;
  }

  set agent(agent: Web5ManagedAgent) {
    this._agent = agent;
  }

  public async clear(): Promise<void> {
    await this._db.clear();
  }

  private async getSyncPeerState(options: {
    syncDirection: 'pull' | 'push'
  }): Promise<SyncState[]> {
    const { syncDirection } = options;

    // Get a list of the DIDs of all registered identities.
    const registeredIdentities = await this._db.sublevel('registeredIdentities').keys().all();

    // Array to accumulate the list of sync peers for each DID.
    const syncPeerState: SyncState[] = [];

    for (let did of registeredIdentities) {
      // Resolve the DID to its DID document.
      const { didDocument, didResolutionMetadata } = await this.agent.didResolver.resolve(did);

      // If DID resolution fails, throw an error.
      if (!didDocument) {
        const errorCode = `${didResolutionMetadata?.error}: ` ?? '';
        const defaultMessage = `Unable to resolve DID: ${did}`;
        const errorMessage = didResolutionMetadata?.errorMessage ?? defaultMessage;
        throw new Error(`SyncManager: ${errorCode}${errorMessage}`);
      }

      // Attempt to get the `#dwn` service entry from the DID document.
      const [ service ] = didUtils.getServices({ didDocument, id: '#dwn' });

      /** Silently ignore and do not try to perform Sync for any DID that does not have a DWN
       * service endpoint published in its DID document. **/
      if (!service) {
        continue;
      }

      if (!didUtils.isDwnServiceEndpoint(service.serviceEndpoint)) {
        throw new Error(`SyncManager: Malformed '#dwn' service endpoint. Expected array of node addresses.`);
      }

      for (let dwnUrl of service.serviceEndpoint.nodes) {
        const watermark = await this.getWatermark(did, dwnUrl, syncDirection);
        syncPeerState.push({ did, dwnUrl, watermark });
      }
    }

    return syncPeerState;
  }

  private async enqueueOperations(options: {
    syncDirection: 'pull' | 'push',
    syncPeerState: SyncState[]
  }) {
    const { syncDirection, syncPeerState } = options;

    for (let syncState of syncPeerState) {
      // Get the event log from the remote DWN if pull sync, or local DWN if push sync.
      const eventLog = await this.getDwnEventLog({
        did       : syncState.did,
        dwnUrl    : syncState.dwnUrl,
        syncDirection,
        watermark : syncState.watermark
      });

      const syncOperations: DbBatchOperation[] = [];

      for (let event of eventLog) {
        const operationKey = `${syncState.did}~${syncState.dwnUrl}~${event.messageCid}`;
        const operation: DbBatchOperation = {
          type  : 'put',
          key   : operationKey,
          value : event.watermark
        };

        syncOperations.push(operation);
      }

      if (syncOperations.length > 0) {
        const syncQueue = (syncDirection === 'pull')
          ? this.getPullQueue()
          : this.getPushQueue();
        await syncQueue.batch(syncOperations as any);
      }
    }
  }

  private async getDwnEventLog(options: {
    did: string,
    dwnUrl: string,
    syncDirection: 'pull' | 'push',
    watermark?: string
  }) {
    const { did, dwnUrl, syncDirection, watermark } = options;

    let eventsReply = {} as EventsGetReply;

    if (syncDirection === 'pull') {
      // When sync is a pull, get the event log from the remote DWN.
      const eventsGetMessage = await this.agent.dwnManager.createMessage({
        author         : did,
        messageType    : 'EventsGet',
        messageOptions : { watermark }
      });

      try {
        eventsReply = await this.agent.rpcClient.sendDwnRequest({
          dwnUrl    : dwnUrl,
          targetDid : did,
          message   : eventsGetMessage
        });
      } catch {
        // If a particular DWN service endpoint is unreachable, silently ignore.
      }

    } else if (syncDirection === 'push') {
      // When sync is a push, get the event log from the local DWN.
      ({ reply: eventsReply } = await this.agent.dwnManager.processRequest({
        author         : did,
        target         : did,
        messageType    : 'EventsGet',
        messageOptions : { watermark }
      }));
    }

    const eventLog = eventsReply.events ?? [];

    return eventLog;
  }


























  public async pull(): Promise<void> {
    const syncPeerState = await this.getSyncPeerState({ syncDirection: 'pull' });
    await this.enqueueOperations({ syncDirection: 'pull', syncPeerState });
    // await this.enqueuePull();

    const pullQueue = this.getPullQueue();
    const pullJobs = await pullQueue.iterator().all();

    const deleteOperations: DbBatchOperation[] = [];
    const errored: Set<string> = new Set();

    for (let job of pullJobs) {
      const [key, watermark] = job;
      const [did, dwnUrl, messageCid] = key.split('~');

      // If a particular DWN service endpoint is unreachable, skip subsequent pull operations.
      if (errored.has(dwnUrl)) {
        continue;
      }

      const messageExists = await this.messageExists(did, messageCid);
      if (messageExists) {
        await this.setWatermark(did, dwnUrl, 'pull', watermark);
        deleteOperations.push({ type: 'del', key });

        continue;
      }

      const messagesGet = await this.agent.dwnManager.createMessage({
        author         : did,
        messageType    : 'MessagesGet',
        messageOptions : {
          messageCids: [messageCid]
        }
      });

      let reply: MessagesGetReply;

      try {
        reply = await this.agent.rpcClient.sendDwnRequest({
          dwnUrl,
          targetDid : did,
          message   : messagesGet
        }) as MessagesGetReply;
      } catch(e) {
        errored.add(dwnUrl);
        continue;
      }

      // TODO
      /** Per Moe, this loop exists because the original intent was to pass multiple messageCid
       * values to batch network requests for record messages rather than one at a time, as it
       * is currently implemented.  Either the pull() method should be refactored to batch
       * getting messages OR this loop should be removed. */
      for (let entry of reply.messages ?? []) {
        if (entry.error || !entry.message) {
          console.warn(`SyncManager: Message '${messageCid}' not found. Ignorning entry: ${JSON.stringify(entry, null, 2)}`);

          await this.setWatermark(did, dwnUrl, 'pull', watermark);
          await this.addMessage(did, messageCid);
          deleteOperations.push({ type: 'del', key });

          continue;
        }

        const messageType = this.getDwnMessageType(entry.message);
        let dataStream;

        if (messageType === 'RecordsWrite') {
          const { encodedData } = entry;
          const message = entry.message as RecordsWriteMessage;

          if (encodedData) {
            const dataBytes = Convert.base64Url(encodedData).toUint8Array();
            dataStream = DataStream.fromBytes(dataBytes);
          } else {
            const recordsRead = await this.agent.dwnManager.createMessage({
              author         : did,
              messageType    : 'RecordsRead',
              messageOptions : {
                recordId: message['recordId']
              }
            });

            const recordsReadReply = await this.agent.rpcClient.sendDwnRequest({
              dwnUrl,
              targetDid : did,
              message   : recordsRead
            }) as RecordsReadReply;

            const { record, status: readStatus } = recordsReadReply;

            if (is2xx(readStatus.code) && record) {
              /** If the read was successful, convert the data stream from web ReadableStream
                 * to Node.js Readable so that the DWN can process it.*/
              dataStream = webReadableToIsomorphicNodeReadable(record.data as any);

            } else if (readStatus.code >= 400) {
              const pruneReply = await this.agent.dwnManager.writePrunedRecord({
                targetDid: did,
                message
              });

              if (pruneReply.status.code === 202 || pruneReply.status.code === 409) {
                await this.setWatermark(did, dwnUrl, 'pull', watermark);
                await this.addMessage(did, messageCid);
                deleteOperations.push({ type: 'del', key });

                continue;
              } else {
                throw new Error(`SyncManager: Failed to sync tombstone for message '${messageCid}'`);
              }
            }
          }
        }

        const pullReply = await this.agent.dwnManager.processMessage({
          targetDid : did,
          message   : entry.message,
          dataStream
        });

        if (pullReply.status.code === 202 || pullReply.status.code === 409) {
          await this.setWatermark(did, dwnUrl, 'pull', watermark);
          await this.addMessage(did, messageCid);
          deleteOperations.push({ type: 'del', key });
        }
      }
    }

    await pullQueue.batch(deleteOperations as any);
  }

  public async push(): Promise<void> {
    const syncPeerState = await this.getSyncPeerState({ syncDirection: 'push' });
    await this.enqueueOperations({ syncDirection: 'push', syncPeerState });
    // await this.enqueuePush();

    const pushQueue = this.getPushQueue();
    const pushJobs = await pushQueue.iterator().all();

    const deleteOperations: DbBatchOperation[] = [];
    const errored: Set<string> = new Set();

    for (let job of pushJobs) {
      const [key, watermark] = job;
      const [did, dwnUrl, messageCid] = key.split('~');

      // If a particular DWN service endpoint is unreachable, skip subsequent push operations.
      if (errored.has(dwnUrl)) {
        continue;
      }

      const dwnMessage = await this.getDwnMessage(did, messageCid);
      if (!dwnMessage) {
        deleteOperations.push({ type: 'del', key: key });
        await this.setWatermark(did, dwnUrl, 'push', watermark);
        await this.addMessage(did, messageCid);

        continue;
      }

      try {
        const reply = await this.agent.rpcClient.sendDwnRequest({
          dwnUrl,
          targetDid : did,
          data      : dwnMessage.data,
          message   : dwnMessage.message
        });

        if (reply.status.code === 202 || reply.status.code === 409) {
          await this.setWatermark(did, dwnUrl, 'push', watermark);
          await this.addMessage(did, messageCid);
          deleteOperations.push({ type: 'del', key: key });
        }
      } catch {
        // Error is intentionally ignored; 'errored' set is updated with 'dwnUrl'.
        errored.add(dwnUrl);
      }
    }

    await pushQueue.batch(deleteOperations as any);
  }

  public async registerIdentity(options: {
    did: string
  }): Promise<void> {
    const { did } = options;

    const registeredIdentities = this._db.sublevel('registeredIdentities');

    await registeredIdentities.put(did, '');
  }

  private async getDwnMessage(
    author: string,
    messageCid: string
  ): Promise<DwnMessage | undefined> {
    let messagesGetResponse = await this.agent.dwnManager.processRequest({
      author         : author,
      target         : author,
      messageType    : 'MessagesGet',
      messageOptions : {
        messageCids: [messageCid]
      }
    });

    const reply: MessagesGetReply = messagesGetResponse.reply;

    /** Absence of a messageEntry or message within messageEntry can happen because updating a
     * Record creates another RecordsWrite with the same recordId. Only the first and
     * most recent RecordsWrite messages are kept for a given recordId. Any RecordsWrite messages
     * that aren't the first or most recent are discarded by the DWN. */
    if (!(reply.messages && reply.messages.length === 1)) {
      return undefined;
    }

    const [ messageEntry ] = reply.messages;

    let { message } = messageEntry;
    if (!message) {
      return undefined;
    }

    let dwnMessage: DwnMessage = { message };
    const messageType = `${message.descriptor.interface}${message.descriptor.method}`;

    // if the message is a RecordsWrite, either data will be present, OR we have to get it using a RecordsRead
    if (messageType === 'RecordsWrite') {
      const { encodedData } = messageEntry;
      const writeMessage = message as RecordsWriteMessage;

      if (encodedData) {
        const dataBytes = Convert.base64Url(encodedData).toUint8Array();
        dwnMessage.data = new Blob([dataBytes]);
      } else {
        let readResponse = await this.agent.dwnManager.processRequest({
          author         : author,
          target         : author,
          messageType    : 'RecordsRead',
          messageOptions : {
            recordId: writeMessage.recordId
          }
        });
        const reply = readResponse.reply as RecordsReadReply;

        if (is2xx(reply.status.code) && reply.record) {
          // If status code is 200-299, return the data.
          const dataBytes = await DataStream.toBytes(reply.record.data);
          dwnMessage.data = new Blob([dataBytes]);

        } else if (is4xx(reply.status.code)) {
          /** If status code is 400-499, typically 404 indicating the data no longer exists, it is
           * likely that a `RecordsDelete` took place. `RecordsDelete` keeps a `RecordsWrite` and
           * deletes the associated data, effectively acting as a "tombstone."  Sync still needs to
           * _push_ this tombstone so that the `RecordsDelete` can be processed successfully. */

        } else {
          // If status code is anything else (likely 5xx), throw an error.
          const { status } = reply;
          throw new Error(`SyncManager: Failed to read data associated with record ${writeMessage.recordId}. (${status.code}) ${status.detail}}`);
        }
      }
    }

    return dwnMessage;
  }

  private async getWatermark(did: string, dwnUrl: string, direction: SyncDirection) {
    const wmKey = `${did}~${dwnUrl}~${direction}`;
    const watermarkStore = this.getWatermarkStore();

    try {
      return await watermarkStore.get(wmKey);
    } catch(error: any) {
      // Don't throw when a key wasn't found.
      if (error.code === 'LEVEL_NOT_FOUND') {
        return undefined;
      }
    }
  }

  private async setWatermark(did: string, dwnUrl: string, direction: SyncDirection, watermark: string) {
    const wmKey = `${did}~${dwnUrl}~${direction}`;
    const watermarkStore = this.getWatermarkStore();

    return watermarkStore.put(wmKey, watermark);
  }

  private async messageExists(did: string, messageCid: string) {
    const messageStore = this.getMessageStore(did);
    const hashedKey = new Set([messageCid]);

    const itr = messageStore.keys({ lte: messageCid, limit: 1 });
    for await (let key of itr) {
      if (hashedKey.has(key)) {
        return true;
      } else {
        return false;
      }
    }
  }

  private async addMessage(did: string, messageCid: string) {
    const messageStore = this.getMessageStore(did);

    return messageStore.put(messageCid, '');
  }

  private getMessageStore(did: string) {
    return this._db.sublevel('history').sublevel(did).sublevel('messages');
  }

  private getWatermarkStore() {
    return this._db.sublevel('watermarks');
  }

  private getPushQueue() {
    return this._db.sublevel('pushQueue');
  }

  private getPullQueue() {
    return this._db.sublevel('pullQueue');
  }

  // TODO: export BaseMessage from dwn-sdk.
  private getDwnMessageType(message: any) {
    return `${message.descriptor.interface}${message.descriptor.method}`;
  }
}
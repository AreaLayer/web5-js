import { expect } from 'chai';
import sinon from 'sinon';

import { Web5DID } from '../../../src/did/Web5DID.js';
import * as didDocuments from '../../data/didDocuments.js';

describe('Web5DID', async () => {
  let web5did;

  beforeEach(function () {
    web5did = new Web5DID();
  });

  describe('getDidDocument', async () => {
    it('should return a didDocument for a valid did:key DID', async () => {
      sinon.stub(web5did, 'resolve').resolves(didDocuments.key.oneVerificationMethodJwk);
  
      const didDocument = await web5did.getDidDocument('resolve-stubbed');

      expect(didDocument['@context'][0]).to.equal('https://www.w3.org/ns/did/v1');
      expect(didDocument).to.have.property('id', didDocuments.key.oneVerificationMethodJwk.didDocument.id);
    });

    it('should return null didDocument for an invalid did:key DID', async () => {
      sinon.stub(web5did, 'resolve').resolves(didDocuments.key.notFound);
  
      const didDocument = await web5did.getDidDocument('resolve-stubbed');
      
      expect(didDocument).to.be.null;
    });
  });

  describe('resolve', async () => {
    it('should return a didResolutionResult for a valid DID', async () => {
      const did = 'did:key:z6MkhvthBZDxVvLUswRey729CquxMiaoYXrT5SYbCAATc8V9';
  
      const resolved = await web5did.resolve(did);

      expect(resolved['@context']).to.equal('https://w3id.org/did-resolution/v1');
      expect(resolved.didDocument).to.have.property('id', did);
    });

    it('should return null didDocument for an invalid DID', async () => {
      const did = 'did:key:invalid';
  
      const resolved = await web5did.resolve(did);
      
      expect(resolved.didDocument).to.be.null;
      expect(resolved.didResolutionMetadata.error).to.equal('invalidDid');
    });
  });
});
const assert = require('assert').strict;
const { encode } = require('bs58check');
const createHash = require('create-hash');
const wif = require('wif');
const bitcoin = require('bitcoinjs-lib');
const bitcoinMessage = require('bitcoinjs-message');
const uniq = require('lodash/uniq');
const { privateToPublic, publicToAddress, toChecksumAddress } = require('ethereumjs-util');
const Web3 = require('web3');

const HD = require('../wallet/hd');
const {
  BTC_DUST,
  BTC_BLOCKCHAIN,
  ETH_BLOCKCHAIN,
  OMNI_BLOCKCHAIN,
  TESTNET,
} = require('./constants');

const didUtils = exports;

/**
 * Util to prepare the details object required for bct based DID creation.
 * @param {string} blockchain
 * @param {object} masterRoot
 * @param {number} childIndexes
 * @param {string} network
 * @returns {Object}
 */
didUtils.prepareInputs = async (blockchain, masterRoot, childIndexes, network) => {
  const allowedChains = [BTC_BLOCKCHAIN, ETH_BLOCKCHAIN, OMNI_BLOCKCHAIN];
  const _childIndexes = uniq(childIndexes);
  assert.strictEqual(allowedChains.includes(blockchain), true, 'Invalid blockchain value provided.');
  assert.strictEqual(
    typeof masterRoot,
    'object',
    'Invalid single dimension ID provided.',
  );
  assert.strictEqual(
    _childIndexes.length === 2,
    true,
    'Invalid childIndexes length provided.',
  );
  let _coinType = 0;
  if (blockchain === ETH_BLOCKCHAIN) {
    _coinType = 60;
  }
  if (blockchain === OMNI_BLOCKCHAIN) {
    _coinType = 200;
  }
  if (network === TESTNET) {
    _coinType = 1;
  }
  const derivationPath = `m/44'/${_coinType}'/0'/0`;
  const singleDimensionID = HD.derive(masterRoot, derivationPath);
  const preparedInputs = {};
  preparedInputs.keyPairs = {};
  preparedInputs.data = { blockchain, network };
  for (let i = 0; i < _childIndexes.length; i++) {
    const derivedChild = singleDimensionID.deriveChild(_childIndexes[i]);
    let publicKey = null;
    let privateKey = null;
    if (blockchain === BTC_BLOCKCHAIN) {
      ({ publicKey, privateKey } = didUtils.getBTCKeypair(blockchain, network, derivedChild));
    }
    if (blockchain === ETH_BLOCKCHAIN) {
      ({ publicKey, privateKey } = didUtils.getETHKeypair(derivedChild));
    }
    if (blockchain === OMNI_BLOCKCHAIN) {
      ({ publicKey, privateKey } = didUtils.getBTCKeypair(blockchain, network, derivedChild));
    }
    preparedInputs.keyPairs[_childIndexes[i]] = { publicKey, privateKey };
    if (i === 0) {
      preparedInputs.data.didCreator = publicKey;
    }
    if (i === 1) {
      preparedInputs.data.didUpdater = publicKey;
    }
  }
  return preparedInputs;
};

/**
 * Util to obtain address from public key.
 * @param {string} blockchain
 * @param {string} network
 * @param {string} publicKey
 * @returns {string}
 */
didUtils.convertPubkeyToAddr = (blockchain, network, publicKey) => {
  const sha256 = createHash('sha256').update(publicKey).digest();
  const rmd160 = createHash('rmd160').update(sha256).digest();

  const tmpBuffer = Buffer.allocUnsafe(21);
  tmpBuffer.writeUInt8(0x6f, 0);
  rmd160.copy(tmpBuffer, 1);
  const btcAddr = encode(tmpBuffer);
  return btcAddr;
};

/**
 * Util to convert raw private key to proper format.
 * @param {string} blockchain
 * @param {string} network
 * @param {string} privateKey
 * @returns {string}
 */
/** TODO */
didUtils.obtainPrivkeyfromRaw = (blockchain, network, privateKey) => {
  const privKey = Buffer.from(privateKey, 'hex');
  const key = wif.encode(network === TESTNET ? 239 : 128, privKey, true);
  // 239 for testent; 128 for mainnet
  return key;
};

/**
 * Method to create and sign a BTC transaction
 * @param {{
 *  didCreator: string
 *  didUpdater: string
 *  blockchain: string
 *  network: string
 * }} param0
 * @param {{
 *  unspents: Object[]
 *  fee: string
 * }} param1
 * @param {string} privKey
 * @returns {string}
 */
didUtils.createAndSignTx = (
  {
    didCreator: creator, didUpdater: updater, blockchain, network,
  },
  { unspents, fee },
  privKey,
) => {
  assert.strictEqual(blockchain, BTC_BLOCKCHAIN, 'Invalid blockchain provided.');
  let totalAmount = 0;
  const sendAmt = BTC_DUST;
  const nw = network === TESTNET ? bitcoin.networks.testnet : bitcoin.networks.bitcoin;
  const signer = bitcoin.ECPair.fromWIF(privKey, nw);

  const psbt = new bitcoin.Psbt({ network: nw });
  for (let i = 0; i < unspents.length; i++) {
    const {
      txid,
      vout,
      amount,
      rawTx: { hex },
    } = unspents[i];
    totalAmount += amount;
    psbt.addInput({
      hash: txid,
      index: vout,
      nonWitnessUtxo: Buffer.from(hex, 'hex'),
    });
  }
  psbt.addOutput({
    address: updater,
    value: parseInt(sendAmt * 10 ** 8, 10),
  });
  const change = parseInt((totalAmount - (sendAmt + Number(fee))) * 10 ** 8, 10);
  if (change > 0) {
    psbt.addOutput({
      address: creator,
      value: change,
    });
  }
  psbt.signAllInputs(signer);
  const valid = psbt.validateSignaturesOfAllInputs();
  if (valid) {
    psbt.finalizeAllInputs();
    const txHex = psbt.extractTransaction().toHex();
    return txHex;
  }
  throw new Error('Invalid private key provided.');
};

/**
 * Function to verify a given signature is valid or not.
 * @param {string} message
 * @param {string} publicKey
 * @param {string} signature
 * @param {string} blockchain
 * @returns {boolean}
 */
didUtils.verifySign = async (message, publicKey, signature, blockchain) => {
  if (blockchain === ETH_BLOCKCHAIN) {
    const web3 = new Web3();
    const signerPubKey = await web3.eth.accounts.recover(message, signature);
    if (signerPubKey === publicKey) {
      return true;
    }
    return false;
  }
  const verify = bitcoinMessage.verify(message, publicKey, signature);
  return verify;
};

/**
 * Helper function to obtain a BTC keypair.
 * @param {string} blockchain
 * @param {string} network
 * @param {object} derivedChild
 * @returns {object}
 */
didUtils.getBTCKeypair = (blockchain, network, derivedChild) => {
  const childsPublicAddr = didUtils.convertPubkeyToAddr(
    blockchain,
    network,
    derivedChild.publicKey,
  );
  const childsPrivateKey = didUtils.obtainPrivkeyfromRaw(
    blockchain,
    network,
    derivedChild.privateKey,
  );
  return {
    publicKey: childsPublicAddr,
    privateKey: childsPrivateKey,
  };
};

/**
 * Helper function to obtain a BTC keypair.
 * @param {object} derivedChild
 * @returns {object}
 */
didUtils.getETHKeypair = (derivedChild) => {
  const pubKey = privateToPublic(derivedChild.privateKey);
  const addr = publicToAddress(pubKey).toString('hex');
  const childsPublicAddr = toChecksumAddress(`0x${addr}`);
  const childsPrivateKey = derivedChild.privateKey.toString('hex');
  return {
    publicKey: childsPublicAddr,
    privateKey: childsPrivateKey,
  };
};

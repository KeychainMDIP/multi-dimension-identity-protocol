/* eslint-disable operator-linebreak */ // TODO: critical change. needs testing after updates.
/* eslint-disable prefer-template */ // TODO: critical change. needs testing after updates.
/* eslint-disable no-bitwise */ // necessary for encoding logic.
const bech32 = require('bech32');
const mdip = require('../client/mdip');

const MAGIC_BTC_MAINNET = 0x03;
const MAGIC_BTC_MAINNET_EXTENDED = 0x04;
const MAGIC_BTC_TESTNET = 0x06;
const MAGIC_BTC_TESTNET_EXTENDED = 0x07;

const TXREF_BECH32_HRP_MAINNET = 'tx';
const TXREF_BECH32_HRP_TESTNET = 'txtest';

const CHAIN_MAINNET = 'mainnet';
const CHAIN_TESTNET = 'testnet';

const txrefEncode = (chain, blockHeight, txPos, utxoIndex) => {
  const prefix =
    chain === CHAIN_MAINNET
      ? TXREF_BECH32_HRP_MAINNET
      : TXREF_BECH32_HRP_TESTNET;
  // const nonStandard = chain !== CHAIN_MAINNET;
  const extendedTxref = utxoIndex !== undefined;

  let magic;
  if (extendedTxref) {
    magic =
      chain === CHAIN_MAINNET
        ? MAGIC_BTC_MAINNET_EXTENDED
        : MAGIC_BTC_TESTNET_EXTENDED;
  } else {
    magic = chain === CHAIN_MAINNET ? MAGIC_BTC_MAINNET : MAGIC_BTC_TESTNET;
  }

  let shortId;
  if (extendedTxref) {
    shortId = [
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
    ]; // 12
  } else {
    shortId = [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]; // 9
  }

  if (blockHeight > 0xffffff || txPos > 0x7fff || magic > 0x1f) {
    return null;
  }

  if (extendedTxref && utxoIndex > 0x7fff) {
    return null;
  }

  /* set the magic */
  shortId[0] = magic;

  /* make sure the version bit is 0 */
  shortId[1] &= ~(1 << 0);

  shortId[1] |= (blockHeight & 0xf) << 1;
  shortId[2] |= (blockHeight & 0x1f0) >> 4;
  shortId[3] |= (blockHeight & 0x3e00) >> 9;
  shortId[4] |= (blockHeight & 0x7c000) >> 14;
  shortId[5] |= (blockHeight & 0xf80000) >> 19;

  shortId[6] |= txPos & 0x1f;
  shortId[7] |= (txPos & 0x3e0) >> 5;
  shortId[8] |= (txPos & 0x7c00) >> 10;

  if (extendedTxref) {
    shortId[9] |= utxoIndex & 0x1f;
    shortId[10] |= (utxoIndex & 0x3e0) >> 5;
    shortId[11] |= (utxoIndex & 0x7c00) >> 10;
  }

  const result = bech32.encode(prefix, shortId);

  const origLength = result.length;
  const breakIndex = prefix.length + 1;
  let finalResult =
    result.substring(0, breakIndex) +
    ':' +
    result.substring(breakIndex, breakIndex + 4) +
    '-' +
    result.substring(breakIndex + 4, breakIndex + 8) +
    '-' +
    result.substring(breakIndex + 8, breakIndex + 12) +
    '-';
  if (origLength - breakIndex < 16) {
    finalResult += result.substring(breakIndex + 12, result.length);
  } else {
    finalResult +=
      result.substring(breakIndex + 12, breakIndex + 16) +
      '-' +
      result.substring(breakIndex + 16, result.length);
  }

  return finalResult;
};

const parseTxDetails = (txData, chain, txid, utxoIndex) => {
  const blockHash = txData.blockhash;
  const blockIndex = txData.txIndex;
  return {
    blockHash,
    blockHeight: txData.blockHeight,
    blockIndex,
    numConfirmations: txData.confirmations,
    chain,
    txHash: txid,
    utxoIndex,
  };
};

function getTxDetails(txid, chain, utxoIndex, mdipURL, blockchain) {
  const theUrl = `${mdipURL}/gettxdetails?txid=${txid}&blockchain=${blockchain}`;

  return mdip
    .get({ url: theUrl })
    .then((txData) => parseTxDetails(txData.result, chain, txid, utxoIndex))
    .catch((err) => {
      throw err;
    });
}

const txidToTxref = (txid, chain, utxoIndx, mdipURL, blockchain) =>
  // eslint-disable-next-line implicit-arrow-linebreak
  getTxDetails(txid, chain, utxoIndx, mdipURL, blockchain).then(
    (data) => {
      const result = txrefEncode(
        chain,
        data.blockHeight,
        data.blockIndex,
        data.utxoIndex,
      );
      return result;
    },
    (error) => {
      throw error;
    },
  );

const txrefDecode = (bech32Tx) => {
  let stripped = bech32Tx.replace(/-/g, '');
  stripped = stripped.replace(/:/g, '');

  const result = bech32.decode(stripped);
  if (result === null) {
    return null;
  }
  const buf = result.words;

  const extendedTxref = buf.length === 12;

  const chainMarker = buf[0];

  let blockHeight = 0;
  let blockIndex = 0;
  let utxoIndex = 0;

  blockHeight = buf[1] >> 1;
  blockHeight |= buf[2] << 4;
  blockHeight |= buf[3] << 9;
  blockHeight |= buf[4] << 14;
  blockHeight |= buf[5] << 19;

  // eslint-disable-next-line prefer-destructuring
  blockIndex = buf[6];
  blockIndex |= buf[7] << 5;
  blockIndex |= buf[8] << 10;

  if (extendedTxref) {
    // eslint-disable-next-line prefer-destructuring
    utxoIndex = buf[9];
    utxoIndex |= buf[10] << 5;
    utxoIndex |= buf[11] << 10;
  }

  let chain;
  if (
    chainMarker === MAGIC_BTC_MAINNET ||
    chainMarker === MAGIC_BTC_MAINNET_EXTENDED
  ) {
    chain = CHAIN_MAINNET;
  } else {
    chain = CHAIN_TESTNET;
  }

  return {
    blockHeight,
    blockIndex,
    chain,
    utxoIndex,
  };
};

const txrefToTxid = (txref, btcClient, isOmni) => new Promise(
  (resolve, reject) => {
    const blockLocation = txrefDecode(txref);
    if (blockLocation === null) {
      reject(new Error('Could not decode txref ' + txref));
    }

    let blockHeight = null;
    let blockIndex = null;
    let chain = null;
    if (blockLocation) {
      ({ blockHeight, blockIndex, chain } = blockLocation);
    }
    btcClient('getblockhash', [blockHeight], isOmni)
      .then((data) => {
        btcClient('getblock', [data.result, 1], isOmni)
          .then((resp) => {
            const blockData = resp.result;
            const txid = blockData.tx[blockIndex];
            if (!txid) {
              reject(new Error('txid does not exists.'));
            }
            resolve({
              txid,
              chain,
              utxoIndex: blockLocation.utxoIndex,
            });
          })
          .catch((err) => {
            reject(err);
          });
      })
      .catch((err) => {
        reject(err);
      });
  },
);

module.exports = {
  txidToTxref,
  txrefToTxid,
};

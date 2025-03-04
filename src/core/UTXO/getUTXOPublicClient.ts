import { UTXOAPIActions, UTXOActions, utxo } from '@bigmi/core'
import type { UTXOAPISchema, UTXOSchema } from '@bigmi/core'
import {
  http,
  type Chain,
  type Client,
  type FallbackTransport,
  type HttpTransport,
  createClient,
  fallback,
  rpcSchema,
} from 'viem'
import { config } from '../../config.js'
import { getRpcUrls } from '../rpc.js'

// cached providers
const publicClients: Record<
  number,
  Client<
    FallbackTransport<readonly HttpTransport[]>,
    Chain,
    undefined,
    UTXOSchema & UTXOAPISchema,
    UTXOActions & UTXOAPIActions
  >
> = {}

/**
 * Get an instance of a provider for a specific chain
 * @param chainId - Id of the chain the provider is for
 * @returns The public client for the given chain
 */
export const getUTXOPublicClient = async (chainId: number) => {
  if (!publicClients[chainId]) {
    const urls = await getRpcUrls(chainId)
    const fallbackTransports = urls.map((url) => http(url))
    const _chain = await config.getChainById(chainId)
    const chain: Chain = {
      ..._chain,
      ..._chain.metamask,
      name: _chain.metamask.chainName,
      rpcUrls: {
        default: { http: _chain.metamask.rpcUrls },
        public: { http: _chain.metamask.rpcUrls },
      },
    }
    const client = createClient({
      chain,
      rpcSchema: rpcSchema<UTXOSchema & UTXOAPISchema>(),
      transport: fallback([
        utxo('https://api.blockchair.com', {
          key: 'blockchair',
          includeChainToURL: true,
        }),
        utxo('https://api.blockcypher.com/v1/btc/main', {
          key: 'blockcypher',
        }),
        utxo('https://mempool.space/api', {
          key: 'mempool',
        }),
        utxo('https://rpc.ankr.com/http/btc_blockbook/api/v2', {
          key: 'ankr',
        }),
        ...fallbackTransports,
      ]),
      pollingInterval: 10_000,
    })
      .extend(UTXOActions)
      .extend(UTXOAPIActions)
    publicClients[chainId] = client
  }

  if (!publicClients[chainId]) {
    throw new Error(`Unable to configure provider for chain ${chainId}`)
  }

  return publicClients[chainId]
}

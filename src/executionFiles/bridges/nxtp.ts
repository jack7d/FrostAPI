import { NxtpSdk, NxtpSdkBase } from '@connext/nxtp-sdk'
import { getChainData } from '@connext/nxtp-sdk/dist/utils'
import { Logger } from '@connext/nxtp-utils'
import { Signer } from 'ethers'

// TODO: move in sdk setup, avoid accessing env variabels
// Add overwrites to specific chains here. They will only be applied if the chain is used.
const getChainConfigOverwrites = () => {
  try {
    return JSON.parse(process.env.REACT_APP_NXTP_OVERWRITES_JSON!)
  } catch (e) {
    return {}
  }
}
const chainConfigOverwrites: {
  [chainId: number]: {
    transactionManagerAddress?: string
    subgraph?: string[]
    subgraphSyncBuffer?: number
  }
} = getChainConfigOverwrites()

const setup = async (
  signer: Signer,
  chainProviders: Record<number, string[]>
): Promise<{ sdk: NxtpSdk; sdkBase: NxtpSdkBase }> => {
  const chainConfig: Record<
    number,
    {
      providers: string[]
      subgraph?: string[]
      transactionManagerAddress?: string
      subgraphSyncBuffer?: number
    }
  > = {}
  Object.entries(chainProviders).forEach(([chainId, providers]) => {
    chainConfig[parseInt(chainId)] = {
      providers: providers,
      subgraph: chainConfigOverwrites[parseInt(chainId)]?.subgraph,
      transactionManagerAddress:
        chainConfigOverwrites[parseInt(chainId)]?.transactionManagerAddress,
      subgraphSyncBuffer:
        chainConfigOverwrites[parseInt(chainId)]?.subgraphSyncBuffer,
    }
  })
  const chainData = await getChainData()

  const sdkBase = new NxtpSdkBase({
    chainConfig,
    signerAddress: signer.getAddress(),
    // signer?: Signer
    // messagingSigner?: Signer
    logger: new Logger({ name: 'NxtpSdkBase', level: 'error' }),
    // network?: "testnet" | "mainnet" | "local"
    // natsUrl?: string
    // authUrl?: string
    // messaging?: UserNxtpNatsMessagingService
    skipPolling: false,
  })

  const sdk = new NxtpSdk({
    chainConfig,
    signer,
    // messagingSigner?: Signer
    logger: new Logger({ name: 'NxtpSdk', level: 'error' }),
    // network?: "testnet" | "mainnet" | "local"
    // natsUrl?: string
    // authUrl?: string
    // messaging?: UserNxtpNatsMessagingService
    // skipPolling?: boolean
    sdkBase,
    chainData,
  })

  return { sdk, sdkBase } // TODO try to remove "big" sdk
}

export default {
  setup,
}

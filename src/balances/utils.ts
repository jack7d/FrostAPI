/* eslint-disable @typescript-eslint/ban-ts-comment */
import { FallbackProvider } from '@ethersproject/providers'
import { ChainId, Token, TokenAmount } from '@lifinance/types'
// @ts-ignore
import { createWatcher } from '@makerdao/multicall'
import BigNumber from 'bignumber.js'
import { BigNumber as BN, constants, Contract } from 'ethers'

import { getMulticallAddresse, getRpcProvider, getRpcUrl } from '../connectors'
import { splitListIntoChunks } from '../utils'

const MAX_MULTICALL_SIZE = 100

type UpdateType = {
  type: string
  value: string
}

type MultiCallConfig = {
  rpcUrl: string
  multicallAddress: string
  interval: number
}

const getBalances = async (
  walletAddress: string,
  tokens: Token[]
): Promise<TokenAmount[]> => {
  if (tokens.length === 0) {
    return []
  }
  const { chainId } = tokens[0]
  tokens.forEach((token) => {
    if (token.chainId !== chainId) {
      // eslint-disable-next-line no-console
      console.warn(`Requested tokens have to be on same chain.`)
      return []
    }
  })

  if (getMulticallAddresse(chainId) && tokens.length > 1) {
    return getBalancesFromProviderUsingMulticall(walletAddress, tokens)
  } else {
    return getBalancesFromProvider(walletAddress, tokens)
  }
}

const getBalancesFromProviderUsingMulticall = async (
  walletAddress: string,
  tokens: Token[]
): Promise<TokenAmount[]> => {
  // Configuration
  const { chainId } = tokens[0]
  const config: MultiCallConfig = {
    rpcUrl: getRpcUrl(chainId),
    multicallAddress: getMulticallAddresse(chainId),
    interval: 1000000000, // calling stop on the watcher does not actually close the websocket
  }

  if (tokens.length > MAX_MULTICALL_SIZE) {
    const chunkedList = splitListIntoChunks<Token>(tokens, MAX_MULTICALL_SIZE)
    const chunkedResults = await Promise.all(
      chunkedList.map((tokenChunk) =>
        executeMulticall(walletAddress, tokenChunk, config, chainId)
      )
    )
    return chunkedResults.flat()
  } else {
    return executeMulticall(walletAddress, tokens, config, chainId)
  }
}

const executeMulticall = (
  walletAddress: string,
  tokens: Token[],
  multiCallConfig: MultiCallConfig,
  chainId: ChainId
) => {
  return new Promise<TokenAmount[]>((resolve) => {
    // Collect calls we want to make
    const calls: any = []
    tokens.forEach(async (token) => {
      if (token.address === constants.AddressZero) {
        calls.push({
          call: ['getEthBalance(address)(uint256)', walletAddress],
          returns: [
            [
              token.address,
              (val: BN) =>
                new BigNumber(val.toString())
                  .shiftedBy(-token.decimals)
                  .toFixed(),
            ],
          ],
        })
      } else {
        calls.push({
          target: token.address,
          call: ['balanceOf(address)(uint256)', walletAddress],
          returns: [
            [
              token.address,
              (val: BN) =>
                new BigNumber(val.toString())
                  .shiftedBy(-token.decimals)
                  .toFixed(),
            ],
          ],
        })
      }
    })

    const watcher = createWatcher(calls, multiCallConfig)

    // Success case
    watcher.batch().subscribe((updates: UpdateType[]) => {
      watcher.stop()

      // map with returned amounts
      const balances: { [tokenId: string]: string } = {}
      updates.forEach(({ type, value }) => {
        balances[type] = value
      })

      // parse to TokenAmounts
      const tokenAmounts = tokens.map((token) => {
        return {
          ...token,
          amount: balances[token.address] || '0',
        }
      })

      resolve(tokenAmounts)
    })

    // Error case
    watcher.onError((error: Error) => {
      watcher.stop()
      // eslint-disable-next-line no-console
      console.warn(
        `Multicall Error on chain ${chainId}, config:`,
        multiCallConfig,
        error
      )
      resolve([])
    })

    // Submit calls
    watcher.start()
  })
}

const getBalancesFromProvider = async (
  walletAddress: string,
  tokens: Token[]
): Promise<TokenAmount[]> => {
  const chainId = tokens[0].chainId
  const rpc = getRpcProvider(chainId)

  const tokenAmountPromises: Promise<TokenAmount>[] = tokens.map(
    async (token): Promise<TokenAmount> => {
      let amount = '0'

      try {
        const amountRaw = await getBalanceFromProvider(
          walletAddress,
          token.address,
          rpc
        )
        amount = amountRaw.shiftedBy(-token.decimals).toString()
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(e)
      }

      return {
        ...token,
        amount,
      }
    }
  )
  return Promise.all(tokenAmountPromises)
}

const getBalanceFromProvider = async (
  walletAddress: string,
  assetId: string,
  provider: FallbackProvider
): Promise<BigNumber> => {
  let balance
  if (assetId === constants.AddressZero) {
    balance = await provider.getBalance(walletAddress)
  } else {
    const contract = new Contract(
      assetId,
      ['function balanceOf(address owner) view returns (uint256)'],
      provider
    )
    balance = await contract.balanceOf(walletAddress)
  }
  return new BigNumber(balance.toString())
}

export default {
  getBalances,
}

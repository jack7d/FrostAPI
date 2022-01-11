import { NxtpSdkEvents } from '@connext/nxtp-sdk'
import { TransactionResponse } from '@ethersproject/abstract-provider'
import { constants, utils } from 'ethers'

import Lifi from '../../Lifi'
import {
  ChainId,
  ExecuteCrossParams,
  Execution,
  getChainById,
  isLifiStep,
  isSwapStep,
} from '../../types'
import { personalizeStep } from '../../utils'
import { getRpcProvider, getRpcUrls } from '../../connectors'
import { checkAllowance } from '../allowance.execute'
import nxtp from './nxtp'
import { getDeployedTransactionManagerContract } from '@connext/nxtp-sdk/dist/transactionManager/transactionManager'
import { signFulfillTransactionPayload } from '@connext/nxtp-sdk/dist/utils'
import { balanceCheck } from '../balanceCheck.execute'

export class NXTPExecutionManager {
  shouldContinue = true

  setShouldContinue = (val: boolean): void => {
    this.shouldContinue = val
  }

  execute = async ({
    signer,
    step,
    statusManager,
    hooks,
  }: ExecuteCrossParams): Promise<Execution> => {
    const { action, estimate } = step
    const currentExecution = statusManager.initExecutionObject(step)
    const fromChain = getChainById(action.fromChainId)
    const toChain = getChainById(action.toChainId)
    const oldCrossProcess = currentExecution.process.find(
      (p) => p.id === 'crossProcess'
    )
    const transactionId = step.id

    // STEP 0: Check Allowance ////////////////////////////////////////////////
    if (action.fromToken.address !== constants.AddressZero) {
      // Check Token Approval only if fromToken is not the native token => no approval needed in that case
      if (!this.shouldContinue) return currentExecution
      await checkAllowance(
        signer,
        step,
        fromChain,
        action.fromToken,
        action.fromAmount,
        estimate.approvalAddress,
        statusManager,
        currentExecution,
        true
      )
    }

    // STEP 1: Get Public Key ////////////////////////////////////////////////
    // check that a public key hook is given and that step allows encryption
    if (
      hooks.getPublicKeyHook &&
      isLifiStep(step) &&
      isSwapStep(step.includedSteps[step.includedSteps.length - 1]) &&
      (!oldCrossProcess || !oldCrossProcess.txHash)
    ) {
      // -> set currentExecution
      const keyProcess = statusManager.findOrCreateProcess(
        'publicKey',
        step,
        currentExecution,
        'Provide Public Key',
        {
          status: 'ACTION_REQUIRED',
        }
      )
      if (!this.shouldContinue) return currentExecution
      // -> request key
      try {
        const encryptionPublicKey = await hooks.getPublicKeyHook()
        // store key
        if (!step.estimate.data) step.estimate.data = {}
        step.estimate.data.encryptionPublicKey = encryptionPublicKey
      } catch (e: any) {
        statusManager.updateProcess(keyProcess, 'FAILED', {
          errorMessage: e.message,
        })
        statusManager.updateExecution(step, 'FAILED')
        throw e
      }
      // -> set currentExecution
      statusManager.updateProcess(keyProcess, 'DONE')
    }

    // STEP 2: Get Transaction ////////////////////////////////////////////////
    const crossProcess = statusManager.findOrCreateProcess(
      'crossProcess',
      step,
      currentExecution,
      'Prepare Transaction'
    )
    if (crossProcess.status !== 'DONE') {
      let tx: TransactionResponse
      try {
        if (crossProcess.txHash) {
          // -> restore existing tx
          // crossProcess.status = 'PENDING'
          // crossProcess.message = 'Wait for '
          // updateExecution(currentExecution)
          statusManager.updateProcess(crossProcess, 'PENDING')
          const fromProvider = getRpcProvider(step.action.fromChainId)
          tx = await fromProvider.getTransaction(crossProcess.txHash)
        } else {
          // Check balance
          await balanceCheck(signer, step)

          // Prepare transaction
          const personalizedStep = await personalizeStep(signer, step)
          const { transactionRequest } = await Lifi.getStepTransaction(
            personalizedStep
          )
          if (!transactionRequest) {
            statusManager.updateProcess(crossProcess, 'FAILED', {
              errorMessage: 'Unable to prepare Transaction',
            })
            statusManager.updateExecution(step, 'FAILED')
            throw crossProcess.errorMessage
          }

          // STEP 3: Send Transaction ///////////////////////////////////////////////
          statusManager.updateProcess(crossProcess, 'ACTION_REQUIRED')
          if (!this.shouldContinue) return currentExecution

          tx = await signer.sendTransaction(transactionRequest)

          // STEP 4: Wait for Transaction ///////////////////////////////////////////
          statusManager.updateProcess(crossProcess, 'PENDING', {
            txHash: tx.hash,
            txLink: fromChain.metamask.blockExplorerUrls[0] + 'tx/' + tx.hash,
          })
        }
      } catch (e: any) {
        statusManager.updateProcess(crossProcess, 'FAILED', {
          errorMessage: e.message,
          errorCode: e.code,
        })
        statusManager.updateExecution(step, 'FAILED')
        throw e
      }

      try {
        await tx.wait()
      } catch (e: any) {
        if (e.code === 'TRANSACTION_REPLACED' && e.replacement) {
          statusManager.updateProcess(crossProcess, 'PENDING', {
            txHash: e.replacement.hash,
            txLink:
              fromChain.metamask.blockExplorerUrls[0] +
              'tx/' +
              e.replacement.hash,
          })
        } else {
          if (e.message) crossProcess.errorMessage = e.message
          if (e.code) crossProcess.errorCode = e.code
          statusManager.updateProcess(crossProcess, 'FAILED', {
            errorMessage: e.message,
            errorCode: e.code,
          })
          statusManager.updateExecution(step, 'FAILED')
          throw e
        }
      }

      statusManager.updateProcess(crossProcess, 'DONE', {
        message: 'Transfer started: ',
      })
    }

    // STEP 5: Wait for ReceiverTransactionPrepared //////////////////////////////////////
    const claimProcess = statusManager.findOrCreateProcess(
      'claimProcess',
      step,
      currentExecution,
      'Wait for bridge'
    )
    // reset previous process
    statusManager.updateProcess(claimProcess, 'PENDING', {
      message: 'Wait for bridge',
    })

    // init sdk
    const crossableChains = [ChainId.ETH, action.fromChainId, action.toChainId]
    const chainProviders = getRpcUrls(crossableChains)
    const { sdk: nxtpSDK, sdkBase: nxtpBaseSDK } = await nxtp.setup(
      signer,
      chainProviders
    )

    const preparedTransactionPromise = nxtpSDK.waitFor(
      NxtpSdkEvents.ReceiverTransactionPrepared,
      10 * 60 * 1000, // = 10 minutes
      (data) => data.txData.transactionId === transactionId
    )

    // find current status
    const transactions = await nxtpBaseSDK
      .getActiveTransactions()
      .catch(() => [])
    const foundTransaction = transactions.find(
      (transfer) =>
        transfer.crosschainTx.invariant.transactionId === transactionId
    )

    // check if already done?
    if (!foundTransaction) {
      const historicalTransactions = await nxtpBaseSDK
        .getHistoricalTransactions()
        .catch(() => [])
      const foundTransaction = historicalTransactions.find(
        (transfer) =>
          transfer.crosschainTx.invariant.transactionId === transactionId
      )

      if (foundTransaction) {
        switch (foundTransaction.status) {
          case 'CANCELLED':
            statusManager.updateProcess(claimProcess, 'CANCELLED')
            break
          case 'FULFILLED':
            statusManager.updateProcess(claimProcess, 'DONE', {
              message: 'Funds received: ',
              txHash: foundTransaction.fulfilledTxHash,
              txLink:
                toChain.metamask.blockExplorerUrls[0] +
                'tx/' +
                foundTransaction.fulfilledTxHash,
            })

            statusManager.updateExecution(step, 'DONE', {
              fromAmount: estimate.fromAmount,
              toAmount: estimate.toAmount,
            })

            break

          default:
            nxtpSDK.removeAllListeners()
            throw new Error(
              `Transaction with unknow state ${foundTransaction.status}`
            )
        }

        // DONE
        nxtpSDK.removeAllListeners()
        return currentExecution
      }
    }

    // STEP 6: Wait for signature //////////////////////////////////////////////////////////
    let calculatedRelayerFee
    let signature
    try {
      calculatedRelayerFee = await nxtp.calculateRelayerFee(nxtpBaseSDK, {
        txData: {
          sendingChainId: action.fromChainId,
          sendingAssetId: action.fromToken.address,
          receivingChainId: action.toChainId,
          receivingAssetId: action.toToken.address,
        },
      })

      const receivingChainTxManager = getDeployedTransactionManagerContract(
        action.toChainId
      )
      if (!receivingChainTxManager) {
        statusManager.updateProcess(claimProcess, 'FAILED', {
          errorMessage: `No TransactionManager definded for chain: ${action.toChainId}`,
        })
        statusManager.updateExecution(step, 'FAILED')
        nxtpSDK.removeAllListeners()
        throw new Error(
          `No TransactionManager definded for chain: ${action.toChainId}`
        )
      }

      statusManager.updateProcess(claimProcess, 'ACTION_REQUIRED')

      if (!this.shouldContinue) {
        nxtpSDK.removeAllListeners()
        return currentExecution
      }

      signature = await signFulfillTransactionPayload(
        transactionId,
        calculatedRelayerFee,
        action.toChainId,
        receivingChainTxManager.address,
        signer
      )
    } catch (e: any) {
      statusManager.updateProcess(claimProcess, 'FAILED', {
        errorMessage: e.message,
      })
      statusManager.updateExecution(step, 'FAILED')
      nxtpSDK.removeAllListeners()
      throw e
    }

    // STEP 7: Wait for Bridge //////////////////////////////////////////////////////////

    statusManager.updateProcess(claimProcess, 'PENDING', {
      message: 'Wait for bridge (1-5 min)',
    })

    let preparedTransaction
    try {
      preparedTransaction = await preparedTransactionPromise
    } catch (e: any) {
      statusManager.updateProcess(claimProcess, 'FAILED', {
        errorMessage: e.message,
      })
      statusManager.updateExecution(step, 'FAILED')
      nxtpSDK.removeAllListeners()
      throw e
    }

    // STEP 8: Decrypt CallData //////////////////////////////////////////////////////////
    let callData = '0x'
    // Does it cointain callData?
    if (preparedTransaction.txData.callDataHash !== utils.keccak256(callData)) {
      if (
        preparedTransaction.txData.callDataHash ===
        utils.keccak256(preparedTransaction.encryptedCallData)
      ) {
        // Call data was passed unencrypted
        callData = preparedTransaction.encryptedCallData
      } else if (hooks.decryptHook) {
        // Tigger hock to decrypt data
        statusManager.updateProcess(claimProcess, 'ACTION_REQUIRED', {
          message: 'Decrypt transaction data',
        })
        if (!this.shouldContinue) {
          nxtpSDK.removeAllListeners()
          return currentExecution
        }

        try {
          callData = await hooks.decryptHook(
            preparedTransaction.encryptedCallData
          )
        } catch (e: any) {
          statusManager.updateProcess(claimProcess, 'FAILED', {
            errorMessage: e.message,
          })
          statusManager.updateExecution(step, 'FAILED')
          nxtpSDK.removeAllListeners()
          throw e
        }
      } else {
        // Continue without call data
        console.warn(
          'CallData not forwared because no decryptHook is set to decypt it.'
        )
      }
    }

    // STEP 9: Wait for Claim //////////////////////////////////////////////////////////
    statusManager.updateProcess(claimProcess, 'PENDING', {
      message: 'Waiting for claim (1-5 min)',
    })

    try {
      const response = await nxtpBaseSDK.fulfillTransfer(
        preparedTransaction,
        signature,
        callData,
        calculatedRelayerFee,
        true
      )

      statusManager.updateProcess(claimProcess, 'PENDING', {
        txHash: response.transactionResponse?.transactionHash,
        txLink:
          toChain.metamask.blockExplorerUrls[0] +
          'tx/' +
          response.transactionResponse?.transactionHash,
        message: 'Funds Received:',
      })
    } catch (e: any) {
      if (e.message) claimProcess.errorMessage = e.message
      nxtpSDK.removeAllListeners()
      statusManager.updateProcess(claimProcess, 'FAILED', {
        errorMessage: e.message,
      })
      statusManager.updateExecution(step, 'FAILED')
      throw e
    }

    const provider = getRpcProvider(step.action.toChainId)
    const claimTx = await provider.getTransaction(claimProcess.txHash)
    const receipt = await provider.waitForTransaction(claimProcess.txHash)

    // wait until balance rpc contains block number >= the claim block number to make sure the funds are available on the users wallet
    let balanceBlockNumber = 0
    const walletAddress = await signer.getAddress()
    do {
      // get balance
      const tokenAmount = await Lifi.getTokenBalance(
        walletAddress,
        step.action.toToken
      )
      if (tokenAmount && tokenAmount.blockNumber) {
        balanceBlockNumber = tokenAmount.blockNumber
      }
    } while (balanceBlockNumber < receipt.blockNumber)

    const parsedReceipt = nxtp.parseReceipt(
      await signer.getAddress(),
      action.toToken.address,
      claimTx,
      receipt
    )

    // status.gasUsed = parsedReceipt.gasUsed
    statusManager.updateProcess(claimProcess, 'DONE')

    statusManager.updateExecution(step, 'DONE', {
      fromAmount: estimate.fromAmount,
      toAmount: parsedReceipt.toAmount,
    })

    // DONE
    nxtpSDK.removeAllListeners()
    return currentExecution
  }
}

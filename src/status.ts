/* eslint-disable max-params */
/* eslint-disable @typescript-eslint/ban-types */
import {
  CallbackFunction,
  emptyExecution,
  EnforcedObjectProperties,
  Execution,
  ExecutionSettings,
  Process,
  ProcessMessage,
  Route,
  Step,
  UpdateExecution,
} from './types'
import { deepClone } from './utils'

export class StatusManager {
  route: Route
  settings: EnforcedObjectProperties<ExecutionSettings>

  constructor(
    route: Route,
    settings: EnforcedObjectProperties<ExecutionSettings>
  ) {
    this.route = route
    this.settings = settings
  }

  initStatus = (step: Step) => {
    const status = step.execution || (deepClone(emptyExecution) as Execution)
    // eslint-disable-next-line no-console
    // const update = updateStatus || console.log
    const updateStepWithStatus = (status: Execution) => {
      step.execution = status
      this.settings.updateCallback(this.route)
    }
    if (!step.execution) {
      updateStepWithStatus(status)
    }
    return { status, updateStepWithStatus }
  }

  createAndPushProcess = (
    id: string,
    updateStatus: (execution: Execution) => void,
    status: Execution,
    message: ProcessMessage,
    params?: object
  ) => {
    const process = status.process.find((p) => p.id === id)
    if (process) {
      status.status = 'PENDING'
      updateStatus(status)
      return process
    }
    const newProcess: Process = {
      id: id,
      startedAt: Date.now(),
      message: message,
      status: 'PENDING',
    }
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        newProcess[key] = value
      }
    }

    status.status = 'PENDING'
    status.process.push(newProcess)
    updateStatus(status)
    return newProcess
  }

  setStatusFailed = (
    updateStatus: UpdateExecution,
    status: Execution,
    currentProcess: Process,
    params?: object
  ) => {
    status.status = 'FAILED'
    currentProcess.status = 'FAILED'
    currentProcess.failedAt = Date.now()
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        currentProcess[key] = value
      }
    }

    updateStatus(status)
  }

  setStatusDone = (
    updateStatus: UpdateExecution,
    status: Execution,
    currentProcess: Process,
    params?: object
  ) => {
    currentProcess.status = 'DONE'
    currentProcess.doneAt = Date.now()
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        currentProcess[key] = value
      }
    }
    updateStatus(status)
  }
}

import type { UnavailableRoutes } from '@lifi/types'
import type { LifiSDKError } from './errors.js'
import { ErrorMessage, ErrorType, LiFiErrorCode } from './errors.js'
import type { ExtendedRequestInit } from '../types/request.js'

interface ServerErrorResponseBody {
  code: number
  message: string
  errors?: UnavailableRoutes
}

const statusCodeToErrorClassificationMap = new Map([
  [
    400,
    { type: ErrorType.ValidationError, code: LiFiErrorCode.ValidationError },
  ],
  [404, { type: ErrorType.NotFoundError, code: LiFiErrorCode.NotFound }],
  [
    409,
    {
      type: ErrorType.SlippageError,
      code: LiFiErrorCode.SlippageError,
      htmlMessage: ErrorMessage.SlippageError,
    },
  ],
  [500, { type: ErrorType.ServerError, code: LiFiErrorCode.InternalError }],
])

const getErrorClassificationFromStatusCode = (code: number) =>
  statusCodeToErrorClassificationMap.get(code) ?? {
    type: ErrorType.ServerError,
    code: LiFiErrorCode.InternalError,
  }

const createInitialMessage = (response: Response) => {
  const statusCode =
    response.status || response.status === 0 ? response.status : ''
  const title = response.statusText || ''
  const status = `${statusCode} ${title}`.trim()
  const reason = status ? `status code ${status}` : 'an unknown error'
  return `Request failed with ${reason}`
}

export class HTTPError extends Error implements Partial<LifiSDKError> {
  public response: Response
  public status: number
  public url: RequestInfo | URL
  public fetchOptions: ExtendedRequestInit
  public code?: LiFiErrorCode
  public type?: ErrorType
  public htmlMessage?: string
  public responseBody?: ServerErrorResponseBody

  constructor(
    response: Response,
    url: RequestInfo | URL,
    options: ExtendedRequestInit
  ) {
    const message = createInitialMessage(response)

    super(message)

    this.name = 'HTTPError'
    this.response = response
    this.status = response.status
    this.message = message
    this.url = url
    this.fetchOptions = options

    if (!options.disableLiFiErrorCodes) {
      this.initLiFiErrorCodeInfo()
    }
  }

  initLiFiErrorCodeInfo() {
    const errorClassification = getErrorClassificationFromStatusCode(
      this.status
    )
    this.type = errorClassification.type
    this.code = errorClassification.code
    this.htmlMessage = errorClassification?.htmlMessage
  }

  // This method populates the error message
  // with information that could be more helpful in debugging in a browser
  async buildAdditionalDetails() {
    if (this.type) {
      this.message = `[${this.type}] ${this.message}`
    }

    try {
      this.responseBody = await this.response.json()
      this.appendMessage('responseMessage', this.responseBody?.message)
    } catch {}

    this.appendMessage('code', this.code)
    this.appendMessage('htmlMessage', this.htmlMessage)
    this.appendMessage('url', this.url)
    this.appendMessage(
      'fetchOptions',
      JSON.stringify(this.fetchOptions, null, 2)
    )

    if (this.responseBody) {
      this.appendMessage(
        'responseBody',
        JSON.stringify(this.responseBody, null, 2)
      )
    }

    return this
  }

  appendMessage(displayName: string, value: any) {
    const spacer = '\n        '

    if (value) {
      this.message += `${spacer}${displayName}: ${value.toString().replaceAll('\n', spacer)}`
    }
  }
}

import { Logger } from './Logger';
import { UnsupportedError, InvalidStateError } from './errors';
import * as utils from './utils';
import * as ortc from './ortc';
import {
    HandlerReceiveOptions, HandlerReceiveResult,
    HandlerReceiveDataChannelResult
} from './handlers/HandlerInterface';
import {
    MediaKind, RtpParameters
} from './RtpParameters';
import { SctpStreamParameters } from './SctpParameters';
import { Transport } from './Transport';
import { AppData } from './types';

const logger = new Logger('Transport');

export type DataConsumerOptions =
{
	id?: string;
	dataProducerId?: string;
	sctpStreamParameters: SctpStreamParameters;
	label?: string;
	protocol?: string;
};

export type ConsumerOptions =
{
	id?: string;
	producerId?: string;
	kind?: 'audio' | 'video';
	rtpParameters: RtpParameters;
	streamId?: string;
};


export class RecvTransport<TransportAppData extends AppData> extends Transport<TransportAppData> {
	// Whether the Consumer for RTP probation has been created.
	private _probatorConsumerCreated = false;

	/**
	 * Create a Consumer to consume a remote Producer.
	 */
	consume(
		{
			id,
			producerId,
			kind,
			rtpParameters,
			streamId,
		}: ConsumerOptions
	): Promise<HandlerReceiveResult>
	{
		logger.debug('consume()');

		rtpParameters = utils.clone(rtpParameters);

		if (this._closed)
		{
			throw new InvalidStateError('closed');
		}
		else if (this._direction !== 'recv')
		{
			throw new UnsupportedError('not a receiving Transport');
		}
		else if (typeof id !== 'string')
		{
			throw new TypeError('missing id');
		}
		else if (typeof producerId !== 'string')
		{
			throw new TypeError('missing producerId');
		}
		else if (kind !== 'audio' && kind !== 'video')
		{
			throw new TypeError(`invalid kind '${kind}'`);
		}

		// Ensure the device can consume it.
		const canConsume = ortc.canReceive(
			rtpParameters, this._extendedRtpCapabilities);

		if (!canConsume)
		{
			throw new UnsupportedError('cannot consume this Producer');
		}


		return this._awaitQueue.push(
			async () =>
			{
				// Video Consumer in order to create the probator.
				let videoConsumerForProbator: {rtpParameters: RtpParameters} | undefined = undefined;

				// Fill options list.
				const optionsList: HandlerReceiveOptions[] = [
					{
						trackId : id!,
						kind    : kind as MediaKind,
						rtpParameters,
						streamId
					}
				];
		
				const results = await this._handler.receive(optionsList);
				var recvResult: HandlerReceiveResult = results[0];

				// If this is the first video Consumer and the Consumer for RTP probation
				// has not yet been created, it's time to create it.
				if (!this._probatorConsumerCreated && !videoConsumerForProbator && kind === 'video')
				{
					videoConsumerForProbator = {rtpParameters};
				}

				// If RTP probation must be handled, do it now.
				if (videoConsumerForProbator)
				{
					try
					{
						const probatorRtpParameters =
							ortc.generateProbatorRtpParameters(videoConsumerForProbator!.rtpParameters);

						await this._handler.receive(
							[ {
								trackId       : 'probator',
								kind          : 'video',
								rtpParameters : probatorRtpParameters
							} ]);

						logger.debug('createConsumer() | Consumer for RTP probation created');

						this._probatorConsumerCreated = true;
					}
					catch (error)
					{
						logger.error(
							'createConsumer() | failed to create Consumer for RTP probation:%o',
							error);
					}
				}
				return recvResult!;
			},
			'transport.createConsumer()');
	}	

	/**
	 * Create a DataConsumer
	 */
	async consumeData(
		{
			id,
			dataProducerId,
			sctpStreamParameters,
			label = '',
			protocol = '',
		}: DataConsumerOptions
	): Promise<HandlerReceiveDataChannelResult>
	{
		logger.debug('consumeData()');

		sctpStreamParameters = utils.clone(sctpStreamParameters);

		if (this._closed)
		{
			throw new InvalidStateError('closed');
		}
		else if (this._direction !== 'recv')
		{
			throw new UnsupportedError('not a receiving Transport');
		}
		else if (!this._maxSctpMessageSize)
		{
			throw new UnsupportedError('SCTP not enabled by remote Transport');
		}
		else if (typeof id !== 'string')
		{
			throw new TypeError('missing id');
		}
		else if (typeof dataProducerId !== 'string')
		{
			throw new TypeError('missing dataProducerId');
		}

		// This may throw.
		ortc.validateSctpStreamParameters(sctpStreamParameters);

		// Enqueue command.
		return this._awaitQueue.push(
			async () =>
			{
				const {
					dataChannel
				} = await this._handler.receiveDataChannel(
					{
						sctpStreamParameters,
						label,
						protocol
					});
				return { dataChannel };
			},
			'transport.consumeData()');
	}
		
	closeConsumer(localId:string): Promise<void> {
        if (this._closed) {
			throw new InvalidStateError('closed');
        }

		return this._awaitQueue.push(
			async () => {
				await this._handler.stopReceiving([localId]);
			},
			'transport.closeConsumer');
    }

	pauseConsumer(localId:string): Promise<void> {
		if (this._closed) {
			logger.error("'pauseConsumer()' | Transport closed");
			throw new InvalidStateError('closed');
		}

		return this._awaitQueue.push(
			async () =>	{
				await this._handler.pauseReceiving([localId]);
			},
			'transport.pauseConsumer');
	}

	resumeConsumer(localId:string): Promise<void> {
		if (this._closed) 
		{
			logger.error("'resumeConsumer()' | Transport closed");
			throw new InvalidStateError('closed');
		}

		return this._awaitQueue.push(
			async () =>
			{
				await this._handler.resumeReceiving([localId]);
			},
			'transport.resumeConsumer');
	}

	getConsumerStats(localId:string): Promise<RTCStatsReport> {
		if (this._closed) {
			throw new InvalidStateError('closed');
		}

		return this._handler.getReceiverStats(localId);
	}
}
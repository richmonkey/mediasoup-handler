import { Logger } from './Logger';
import { UnsupportedError, InvalidStateError } from './errors';
import * as ortc from './ortc';
import {
	HandlerSendResult,
	HandlerSendDataChannelResult
} from './handlers/HandlerInterface';
import {
	RtpCodecCapability, RtpEncodingParameters
} from './RtpParameters';
import { Transport } from './Transport';
import { AppData } from './types';

const logger = new Logger('Transport');

// https://mediasoup.org/documentation/v3/mediasoup-client/api/#ProducerCodecOptions
export type ProducerCodecOptions = {
	opusStereo?: boolean;
	opusFec?: boolean;
	opusDtx?: boolean;
	opusMaxPlaybackRate?: number;
	opusMaxAverageBitrate?: number;
	opusPtime?: number;
	opusNack?: boolean;
	videoGoogleStartBitrate?: number;
	videoGoogleMaxBitrate?: number;
	videoGoogleMinBitrate?: number;
};

export type ProducerOptions = {
	track?: MediaStreamTrack;
	encodings?: RtpEncodingParameters[];
	codecOptions?: ProducerCodecOptions;
	codec?: RtpCodecCapability;
	stopTracks?: boolean;
	disableTrackOnPause?: boolean;
	zeroRtpOnPause?: boolean;
};


export type DataProducerOptions = {
	ordered?: boolean;
	maxPacketLifeTime?: number;
	maxRetransmits?: number;
	label?: string;
	protocol?: string;
};


export class SendTransport<TransportAppData extends AppData = AppData> extends Transport<TransportAppData> {
	/**
	 * Create a Producer.
	 */
	produce({
		track,
		encodings,
		codecOptions,
		codec,
		stopTracks = true,
		disableTrackOnPause = true,
		zeroRtpOnPause = false,
	}: ProducerOptions = {}
	): Promise<HandlerSendResult> {
		logger.debug('produce() [track:%o]', track);

		if (this._closed) {
			throw new InvalidStateError('closed');
		}
		else if (!track) {
			throw new TypeError('missing track');
		}
		else if (this._direction !== 'send') {
			throw new UnsupportedError('not a sending Transport');
		}
		else if (!this._canProduceByKind[track.kind]) {
			throw new UnsupportedError(`cannot produce ${track.kind}`);
		}
		else if (track.readyState === 'ended') {
			throw new InvalidStateError('track ended');
		}

		// Enqueue command.
		return this._awaitQueue.push(
			async () => {
				let normalizedEncodings;

				if (encodings && !Array.isArray(encodings)) {
					throw TypeError('encodings must be an array');
				}
				else if (encodings && encodings.length === 0) {
					normalizedEncodings = undefined;
				}
				else if (encodings) {
					normalizedEncodings = encodings
						.map((encoding: any) => {
							const normalizedEncoding: any = { active: true };

							if (encoding.active === false) {
								normalizedEncoding.active = false;
							}
							if (typeof encoding.dtx === 'boolean') {
								normalizedEncoding.dtx = encoding.dtx;
							}
							if (typeof encoding.scalabilityMode === 'string') {
								normalizedEncoding.scalabilityMode = encoding.scalabilityMode;
							}
							if (typeof encoding.scaleResolutionDownBy === 'number') {
								normalizedEncoding.scaleResolutionDownBy = encoding.scaleResolutionDownBy;
							}
							if (typeof encoding.maxBitrate === 'number') {
								normalizedEncoding.maxBitrate = encoding.maxBitrate;
							}
							if (typeof encoding.maxFramerate === 'number') {
								normalizedEncoding.maxFramerate = encoding.maxFramerate;
							}
							if (typeof encoding.adaptivePtime === 'boolean') {
								normalizedEncoding.adaptivePtime = encoding.adaptivePtime;
							}
							if (typeof encoding.priority === 'string') {
								normalizedEncoding.priority = encoding.priority;
							}
							if (typeof encoding.networkPriority === 'string') {
								normalizedEncoding.networkPriority = encoding.networkPriority;
							}

							return normalizedEncoding;
						});
				}

				const { localId, rtpParameters, rtpSender } = await this._handler.send(
					{
						track,
						encodings: normalizedEncodings,
						codecOptions,
						codec
					});

				try {
					// This will fill rtpParameters's missing fields with default values.
					ortc.validateRtpParameters(rtpParameters);
					return { localId, rtpParameters, rtpSender };
				}
				catch (error) {
					this._handler.stopSending(localId)
						.catch(() => { });

					throw error;
				}
			},
			'transport.produce()')
			// This catch is needed to stop the given track if the command above
			// failed due to closed Transport.
			.catch((error: Error) => {
				if (stopTracks) {
					try { track.stop(); }
					catch (error2) { }
				}

				throw error;
			});
	}


	/**
	 * Create a DataProducer
	 */
	produceData({
		ordered = true,
		maxPacketLifeTime,
		maxRetransmits,
		label = '',
		protocol = '',
	}: DataProducerOptions = {}
	): Promise<HandlerSendDataChannelResult> {
		logger.debug('produceData()');

		if (this._closed) {
			throw new InvalidStateError('closed');
		}
		else if (this._direction !== 'send') {
			throw new UnsupportedError('not a sending Transport');
		}
		else if (!this._maxSctpMessageSize) {
			throw new UnsupportedError('SCTP not enabled by remote Transport');
		}

		if (maxPacketLifeTime || maxRetransmits) {
			ordered = false;
		}

		// Enqueue command.
		return this._awaitQueue.push(
			async () => {
				const {
					dataChannel,
					sctpStreamParameters
				} = await this._handler.sendDataChannel(
					{
						ordered,
						maxPacketLifeTime,
						maxRetransmits,
						label,
						protocol
					});

				// This will fill sctpStreamParameters's missing fields with default values.
				ortc.validateSctpStreamParameters(sctpStreamParameters);

				return {
					dataChannel,
					sctpStreamParameters
				};
			},
			'transport.produceData()');
	}

	closeProducer(localId: string): Promise<void> {
		return this._awaitQueue.push(
			async () => await this._handler.stopSending(localId),
			'producer @close event');
	}

	pauseProducer(localId: string): Promise<void> {
		return this._awaitQueue.push(
			async () => await this._handler.pauseSending(localId),
			'producer @pause event');
	}

	resumeProducer(localId: string): Promise<void> {
		return this._awaitQueue.push(
			async () => await this._handler.resumeSending(localId),
			'producer @resume event');
	}

	replaceTrack(localId: string, track: MediaStreamTrack | null): Promise<void> {
		return this._awaitQueue.push(
			async () => await this._handler.replaceTrack(localId, track),
			'producer @replacetrack event');
	}

	setMaxSpatialLayer(localId: string, spatialLayer: number): Promise<void> {
		return this._awaitQueue.push(
			async () => await this._handler.setMaxSpatialLayer(localId, spatialLayer),
			'producer @setmaxspatiallayer event');
	}

	setRtpEncodingParameters(
		localId: string,
		params: RTCRtpEncodingParameters
	): Promise<void> {
		return this._awaitQueue.push(
			async () => await this._handler.setRtpEncodingParameters(localId, params),
			'producer @setrtpencodingparameters event');
	}

	/**
	 * Get associated RTCRtpSender stats.
	 */
	getProducerStats(localId: string): Promise<RTCStatsReport> {
		if (this._closed) {
			throw new InvalidStateError('closed');
		}

		return this._handler.getSenderStats(localId)
	}
}

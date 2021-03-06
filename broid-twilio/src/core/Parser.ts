import {
  default as schemas,
  IActivityStream,
} from '@broid/schemas';
import { cleanNulls, Logger } from '@broid/utils';

import * as Promise from 'bluebird';
import * as R from 'ramda';
import * as uuid from 'uuid';

import { ITwilioMedia, ITwilioWebHookEvent } from './interfaces';

export class Parser {
  public serviceID: string;
  public generatorName: string;
  private logger: Logger;

  constructor(serviceName: string, serviceID: string, logLevel: string) {
    this.serviceID = serviceID;
    this.generatorName = serviceName;
    this.logger = new Logger('parser', logLevel);
  }

  // Validate parsed data with Broid schema validator
  public validate(event: any): Promise<object | null> {
    this.logger.debug('Validation process', { event });

    const parsed = cleanNulls(event);
    if (!parsed || R.isEmpty(parsed)) { return Promise.resolve(null); }

    if (!parsed.type) {
      this.logger.debug('Type not found.', { parsed });
      return Promise.resolve(null);
    }

    return schemas(parsed, 'activity')
      .then(() => parsed)
      .catch((err) => {
        this.logger.error(err);
        return null;
      });
  }

  // Convert normalized data to Broid schema
  public parse(event: any): Promise<any> {
    this.logger.debug('Parse process', { event });

    const normalized = cleanNulls(event);
    if (!normalized || R.isEmpty(normalized)) { return Promise.resolve(null); }

    const parseMedia = (media): ITwilioMedia | null => {
      let mediaType: string = '';
      if (media.mediatype.startsWith('image')) { mediaType = 'Image';  }
      if (media.mediatype.startsWith('video')) { mediaType = 'Video';  }
      if (mediaType !== '') {
        return {
          mediaType: media.mediatype,
          type: mediaType,
          url: media.url,
        };
      }
      return null;
    };

    const activitystreams = this.createActivityStream(normalized);
    activitystreams.actor = {
      id: normalized.senderPhoneNumber,
      name: normalized.senderPhoneNumber,
      type: 'Person',
    };

    activitystreams.target = {
      id: normalized.toPhoneNumber,
      name: normalized.toPhoneNumber,
      type: 'Person',
    };

    // Process potentially media.
    if (normalized.numMedia === 1) {
      const m = parseMedia(normalized.mediaURLs[0]);
      if (m) {
        activitystreams.object = {
          id: normalized.eventID || this.createIdentifier(),
          mediaType: m.mediaType,
          type: m.type,
          url: m.url,
        };
        if (normalized.text && !R.isEmpty(normalized.text)) {
          activitystreams.object.content = normalized.text;
        }
      }
    } else if (normalized.numMedia > 1) {
      let attachments = R.map(
        (mediaURL) => {
          const m = parseMedia(mediaURL);
          if (m) {
            return m;
          }
          return null;
        },
        normalized.mediaURLs);
      attachments = R.reject(R.isNil)(attachments);

      if (!R.isEmpty(attachments)) {
        activitystreams.object = {
          attachment: attachments,
          content: normalized.text,
          id: normalized.eventID || this.createIdentifier(),
          type: 'Note',
        };
      }
    }

    if (!activitystreams.object && !R.isEmpty(normalized.text)) {
      activitystreams.object = {
        content: normalized.text,
        id: normalized.eventID || this.createIdentifier(),
        type: 'Note',
      };
    }

    return Promise.resolve(activitystreams);
  }

  // Normalize the raw event
  public normalize(event: ITwilioWebHookEvent): Promise<object | null> {
    this.logger.debug('Event received to normalize');

    const body: any = R.path(['request', 'body'], event) as any;

    if (!body || R.isEmpty(body)) { return Promise.resolve(null); }

    const senderPhoneNumber = body.From;
    const toPhoneNumber = body.To;
    const text = body.Body;
    const eventID = body.MessageSid;

    const data = {
      eventID,
      mediaURLs: R.reject(R.isNil)(R.map(
        (num) => {
          const url = body[`MediaUrl${num}`];
          if (url) {
            return {
              mediatype: body[`MediaContentType${num}`],
              url,
            };
          }
          return null;
        },
        R.range(0, 11))),
      numMedia: Number(body.NumMedia),
      senderPhoneNumber,
      text,
      timestamp: body.timestamp || Math.floor(Date.now() / 1000),
      toPhoneNumber,
    };

    return Promise.resolve(data);
  }

  private createIdentifier(): string {
    return uuid.v4();
  }

  private createActivityStream(normalized: any): IActivityStream {
    return {
      '@context': 'https://www.w3.org/ns/activitystreams',
      'generator': {
        id: this.serviceID,
        name: this.generatorName,
        type: 'Service',
      },
      'published': normalized.timestamp || Math.floor(Date.now() / 1000),
      'type': 'Create',
    };
  }
}

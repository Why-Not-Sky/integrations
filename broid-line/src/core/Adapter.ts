import schemas from '@broid/schemas';
import { Logger } from '@broid/utils';

import * as Promise from 'bluebird';
import { Router  } from 'express';
import * as LineBot from 'line-messaging';
import * as R from 'ramda';
import { Observable } from 'rxjs/Rx';
import * as uuid from 'uuid';

import { IAdapterOptions } from './interfaces';
import { Parser } from './Parser';
import { WebHookServer } from './WebHookServer';

// Create a Line Button with AS2 Attachments
const createButtons = (attachments, tpl: null): any => {
  const template = tpl || new LineBot.ButtonTemplateBuilder();

  R.forEach(
    (attachment: any) => {
      let actionType: string = LineBot.Action.POSTBACK;
      if (attachment.mediaType === 'text/html') { actionType = LineBot.Action.URI; }
      template.addAction(attachment.content || attachment.name, attachment.url, actionType);
      return;
    },
    attachments);

  return template;
};

// Create a Line Confirme Button with AS2 Attachment
const createConfirmButton = (attachment): any => {
  const template = new LineBot.ConfirmTemplateBuilder();
  template.setMessage(attachment.content || attachment.name);
  template.setPositiveAction(attachment.yesLabel, attachment.yesLabel);
  template.setNegativeAction(attachment.noLabel, attachment.noLabel);
  return template;
};

export class Adapter {
  private connected: boolean;
  private logLevel: string;
  private logger: Logger;
  private parser: Parser;
  private router: Router;
  private serviceID: string;
  private session: LineBot;
  private storeUsers: Map<string, object>;
  private token: string | null;
  private tokenSecret: string | null;
  private username: string | null;
  private webhookServer: WebHookServer | null;

  constructor(obj: IAdapterOptions) {
    this.serviceID = obj && obj.serviceID || uuid.v4();
    this.logLevel = obj && obj.logLevel || 'info';
    this.token = obj && obj.token || null;
    this.tokenSecret = obj && obj.tokenSecret || null;
    this.username = obj && obj.username || null;
    this.storeUsers = new Map();

    if (this.token === '') {
      throw new Error('Token should exist.');
    }

    if (this.tokenSecret === '') {
      throw new Error('Token secret should exist.');
    }

    if (this.username === '') {
      throw new Error('Username secret should exist.');
    }

    this.parser = new Parser(this.serviceName(), this.serviceID, this.logLevel);
    this.logger = new Logger('adapter', this.logLevel);
    this.router = Router();
    if (obj.http) {
      this.webhookServer = new WebHookServer(obj.http, this.router, this.logLevel);
    }
  }

  // Return list of users information
  public users(): Promise<Map<string, object>> {
    return Promise.resolve(this.storeUsers);
  }

  // Return list of channels information
  public channels(): Promise<Error> {
    return Promise.reject(new Error('Not supported'));
  }

  // Return the service ID of the current instance
  public serviceName(): string {
    return 'line';
  }

  // Return the service ID of the current instance
  public serviceId(): string {
    return this.serviceID;
  }

  public getRouter(): null {
    return null;
  }

  // Connect to Line
  // Start the webhook server
  public connect(): Observable<object> {
    if (this.connected) {
      return Observable.of({ type: 'connected', serviceID: this.serviceId() });
    }

    if (!this.token || !this.tokenSecret || !this.username) {
      return Observable.throw(new Error('Credentials should exist.'));
    }

    this.session = LineBot.create({
      channelID: this.username,
      channelSecret: this.tokenSecret,
      channelToken: this.token,
    });

    this.router.use(this.session.webhook('/'));
    if (this.webhookServer) {
      this.webhookServer.listen();
    }

    this.connected = true;
    return Observable.of({ type: 'connected', serviceID: this.serviceId() });
  }

  public disconnect(): Promise<null> {
    this.connected = false;
    return Promise.resolve(null);
  }

  // Listen 'message' event from Messenger
  public listen(): Observable<object> {
    return Observable.merge(
      Observable.fromEvent(this.session, LineBot.Events.MESSAGE, (...args) => args[1].getEvent()),
      Observable.fromEvent(this.session, LineBot.Events.POSTBACK, (...args) => args[1].getEvent()))
      .mergeMap((event: any) => this.parser.normalize(event))
      .mergeMap((message: any) => {
        if (R.path(['source', 'type'], message) === 'user') {
          return this.user(message.source.userId)
            .then((authorInformation) =>
                  R.assoc('source', authorInformation, message));
        }
        return Promise.resolve(message);
      })
      .mergeMap((normalized) => this.parser.parse(normalized))
      .mergeMap((parsed) => this.parser.validate(parsed))
      .mergeMap((validated) => {
        if (!validated) { return Observable.empty(); }
        return Promise.resolve(validated);
      });
  }

  public send(data: object): Promise<object | Error> {
    this.logger.debug('sending', { message: data });

    return schemas(data, 'send')
      .then(() => {
        const objectType = R.path(['object', 'type'], data);
        if (objectType === 'Collection') {
          let objects: any = R.path(['object', 'items'], data);
          if (!R.is(Array, objects)) { objects = [objects]; }
          const columns = R.map(
            (object: any) => {
              const column = createButtons(
                object.attachment || [],
                new LineBot.CarouselColumnTemplateBuilder());
              column.setTitle(object.name);
              column.setMessage(object.content);
              column.setThumbnail(object.preview || object.url);
              return column;
            },
            objects);

          const carousel = new LineBot.CarouselTemplateBuilder(columns);
          return new LineBot
            .TemplateMessageBuilder('You can\'t see this rich message.', carousel);
        } else {
          const attachments: any[] = R.path(['object', 'attachment'], data) as any[];
          const content = R.path(['object', 'content'], data);
          const name = R.path(['object', 'name'], data);
          const url = R.path(['object', 'url'], data);
          const preview = R.path(['object', 'preview'], data);
          if (R.is(Array, attachments) && !R.isEmpty(attachments)) {
            const attachmentsButtons = R.filter(
              (attachment: any) =>
                attachment.type === 'Button' && R.isEmpty(attachment.attachment || []),
              attachments);
            const attachmentsConfirm = R.filter(
              (attachment: any) =>
                attachment.type === 'Button' && !R.isEmpty(attachment.attachment || []),
              attachments);

            if (!R.isEmpty(attachmentsConfirm)) {
              // we take the first confirm button
              const buttons = createConfirmButton(attachmentsConfirm[0].attachment);
              return new LineBot.TemplateMessageBuilder(content, buttons);
            } else if (!R.isEmpty(attachmentsButtons)) {
              const buttons = createButtons(attachmentsButtons, null);
              buttons.setTitle(name);
              buttons.setMessage(content);
              if (objectType === 'Image' && url) {
                buttons.setThumbnail(preview || url);
              }
              return new LineBot.TemplateMessageBuilder(content, buttons);
            }
          } else if (objectType === 'Note') {
            return new LineBot.TextMessageBuilder(content);
          } else if (objectType === 'Image' || objectType === 'Video') {
            if (url) {
              if (objectType === 'Video') {
                return new LineBot.VideoMessageBuilder(url, preview || url);
              }
              return new LineBot.ImageMessageBuilder(url, preview || url);
            }
          } else if (objectType === 'Place') {
            const latitude = R.path(['object', 'latitude'], data);
            const longitude = R.path(['object', 'longitude'], data);
            return new LineBot
              .LocationMessageBuilder(name || 'Location', content, latitude, longitude);
          }
        }
      })
      .then((messageBuilder) => {
        if (messageBuilder) {
          const replyToken = R.path(['object', 'context', 'content'], data);
          if (replyToken) {
            return this.session.replyMessage(replyToken, messageBuilder);
          }

          const channelID = R.path(['to', 'id'], data);
          return this.session.pushMessage(channelID, messageBuilder);
        }

        return Promise.reject(new Error('Note, Image, Video are only supported.'));
      })
      .then(() => ({ serviceID: this.serviceId(), type: 'sent' }));
  }

  // Return user information
  private user(key: string, cache: boolean = true): Promise<object> {
    if (cache) {
      const data = this.storeUsers.get(key);
      if (data) {
        return Promise.resolve(data);
      }
    }

    return this.session.getProfile(key)
      .then((data) => {
        this.storeUsers.set(key, data);
        return data;
      });
  }
}

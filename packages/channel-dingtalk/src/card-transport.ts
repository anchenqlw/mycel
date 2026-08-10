import DingTalk from "@alicloud/dingtalk";
import { Config as OpenApiConfig } from "@alicloud/openapi-client";
import { RuntimeOptions } from "@alicloud/tea-util";

export interface CardDelivery {
  outTrackId: string;
  recipientUserId: string;
  params: Record<string, string>;
}

export interface CardTransport {
  deliver(input: CardDelivery): Promise<{ cardInstanceId?: string }>;
  update(outTrackId: string, params: Record<string, string>): Promise<void>;
}

export interface DingTalkCardTransportConfig {
  clientId: string;
  clientSecret: string;
  cardTemplateId: string;
  robotCode: string;
}

export class DingTalkOpenApiCardTransport implements CardTransport {
  readonly #config: DingTalkCardTransportConfig;
  readonly #oauth: InstanceType<typeof DingTalk.oauth2_1_0.default>;
  readonly #card: InstanceType<typeof DingTalk.card_1_0.default>;
  #token?: { value: string; expiresAt: number };

  constructor(config: DingTalkCardTransportConfig) {
    this.#config = config;
    const openApiConfig = new OpenApiConfig({ protocol: "https", regionId: "central" });
    this.#oauth = new DingTalk.oauth2_1_0.default(openApiConfig);
    this.#card = new DingTalk.card_1_0.default(openApiConfig);
  }

  async deliver(input: CardDelivery): Promise<{ cardInstanceId?: string }> {
    const token = await this.#accessToken();
    const request = new DingTalk.card_1_0.CreateAndDeliverRequest({
      callbackType: "STREAM",
      cardData: new DingTalk.card_1_0.CreateAndDeliverRequestCardData({ cardParamMap: input.params }),
      cardTemplateId: this.#config.cardTemplateId,
      openSpaceId: `dtv1.card//IM_ROBOT.${input.recipientUserId}`,
      outTrackId: input.outTrackId,
      imRobotOpenDeliverModel: new DingTalk.card_1_0.CreateAndDeliverRequestImRobotOpenDeliverModel({
        robotCode: this.#config.robotCode,
      }),
    });
    const headers = new DingTalk.card_1_0.CreateAndDeliverHeaders({ xAcsDingtalkAccessToken: token });
    const response = await this.#card.createAndDeliverWithOptions(request, headers, new RuntimeOptions({}));
    if (!response.body?.success) throw new Error("DingTalk createAndDeliver returned success=false");
    return {};
  }

  async update(outTrackId: string, params: Record<string, string>): Promise<void> {
    const token = await this.#accessToken();
    const request = new DingTalk.card_1_0.UpdateCardRequest({
      outTrackId,
      cardData: new DingTalk.card_1_0.UpdateCardRequestCardData({ cardParamMap: params }),
      cardUpdateOptions: new DingTalk.card_1_0.UpdateCardRequestCardUpdateOptions({ updateCardDataByKey: true }),
    });
    const headers = new DingTalk.card_1_0.UpdateCardHeaders({ xAcsDingtalkAccessToken: token });
    const response = await this.#card.updateCardWithOptions(request, headers, new RuntimeOptions({}));
    if (!response.body?.success) throw new Error("DingTalk updateCard returned success=false");
  }

  async #accessToken(): Promise<string> {
    if (this.#token && this.#token.expiresAt > Date.now() + 60_000) return this.#token.value;
    const request = new DingTalk.oauth2_1_0.GetAccessTokenRequest({
      appKey: this.#config.clientId,
      appSecret: this.#config.clientSecret,
    });
    const response = await this.#oauth.getAccessToken(request);
    const value = response.body?.accessToken;
    if (!value) throw new Error("DingTalk access token response was empty");
    const expiresIn = response.body?.expireIn ?? 7200;
    this.#token = { value, expiresAt: Date.now() + expiresIn * 1000 };
    return value;
  }
}

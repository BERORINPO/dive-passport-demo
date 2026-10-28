/* Service Binding の RPC の口（entry）。redux-ask の wrangler.ask.jsonc が `services: [{ binding: "SHOP", service: "dive-passport-demo", entrypoint: "ShopRpc" }]`
   でこのクラスにつなぐ。公開するメソッドは shop-service.mjs の 4 つだけ（足すときは ShopService・shop-client.mjs の SHOP_METHODS・fakes.mjs の
   fakeShopBinding・spec/architecture.md を一緒に直す）。Service Binding は公開の URL も Access も通らない。
   中身は素のクラス（ShopService）で、ここは Cloudflare の WorkerEntrypoint に包むだけ（cloudflare:workers はテストの Node では読めない）。
   外へ通信しないので io は時計だけ。Cloudflare の書き方: https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/ */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { ShopService } from './shop-service.mjs';

const CLOCK = { now: () => Date.now() };

export class ShopRpc extends WorkerEntrypoint {
  askView(hash) { return new ShopService(this.env, CLOCK).askView(hash); }

  askApply(hash, req, origin) { return new ShopService(this.env, CLOCK).askApply(hash, req, origin); }

  siteHosts(origin) { return new ShopService(this.env, CLOCK).siteHosts(origin); }

  siteBooking(origin, given) { return new ShopService(this.env, CLOCK).siteBooking(origin, given); }
}

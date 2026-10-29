/* Service Binding の RPC の口（entry）。redux-ask の wrangler.ask.jsonc が `services: [{ binding: "SHOP", service: "dive-passport-demo", entrypoint: "ShopRpc" }]`
   でこのクラスにつなぐ。公開するメソッドは shop-service.mjs の 9 つだけ（足すときは ShopService・shop-client.mjs の SHOP_METHODS・fakes.mjs の
   fakeShopBinding・spec/architecture.md を一緒に直す）。Service Binding は公開の URL も Access も通らない。
   中身は素のクラス（ShopService）で、ここは Cloudflare の WorkerEntrypoint に包むだけ（cloudflare:workers はテストの Node では読めない）。
   io は時計と、試し版の AI（trialAsk）が Claude API を呼ぶ fetch。Cloudflare の書き方: https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/ */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { ShopService } from './shop-service.mjs';

const CLOCK = { now: () => Date.now(), fetch: (url, init) => fetch(url, init) };

export class ShopRpc extends WorkerEntrypoint {
  askView(hash) { return new ShopService(this.env, CLOCK).askView(hash); }

  askApply(hash, req, origin) { return new ShopService(this.env, CLOCK).askApply(hash, req, origin); }

  siteHosts(origin) { return new ShopService(this.env, CLOCK).siteHosts(origin); }

  siteBooking(origin, given) { return new ShopService(this.env, CLOCK).siteBooking(origin, given); }

  walkinView(hash) { return new ShopService(this.env, CLOCK).walkinView(hash); }

  walkinSubmit(hash, req) { return new ShopService(this.env, CLOCK).walkinSubmit(hash, req); }

  intakeBooking(hash, given, idem) { return new ShopService(this.env, CLOCK).intakeBooking(hash, given, idem); }

  trialView(t) { return new ShopService(this.env, CLOCK).trialView(t); }

  trialAsk(t, req) { return new ShopService(this.env, CLOCK).trialAsk(t, req); }
}

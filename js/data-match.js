/* リドが質問から答えを選ぶための言葉（お店ごとに足していく）。答えの文そのものは data.js の R.FAQ にある。
   keys = 強い手がかり、weak = 弱い手がかり、para = 客が聞きそうな言い換え（文の似ている度合いで比べる）。
   英字の言葉は単語の切れ目で、日本語は文字の並びで探す（カタカナとひらがなは同じに扱う） */
(() => {
  'use strict';

  const R = (globalThis.REDUX = globalThis.REDUX || {});

  R.FAQ_MATCH = {
    photo: {
      keys: ['写真', '動画', 'カメラ', '撮影', '撮って', '撮っ', '撮れ', 'ビデオ', 'photo', 'picture', 'pic', 'video', 'camera', 'gopro', 'footage'],
      weak: [],
      para: ['写真はもらえますか', '写真は何枚もらえますか', '動画も撮ってもらえますか', 'カメラを持って行ってもいいですか',
        'do we get photos', 'will you take pictures of us', 'can i bring a camera']
    },
    cancel: {
      keys: ['天気', '天候', '悪天候', '雨', '中止', '台風', '荒天', '返金', '払い戻', 'weather', 'rain', 'rainy', 'storm', 'typhoon', 'refund', 'windy'],
      weak: ['風', '波', 'cancel', 'cancelled', 'canceled', 'wind', 'waves'],
      para: ['天気が悪いときはどうなりますか', '雨でもやりますか', '中止のときは返金されますか',
        'what if the weather is bad', 'do you refund if the tour is cancelled']
    },
    total: {
      keys: ['料金', 'いくら', '追加', '総額', '駐車', '値段', '別料金', '費用', '込み', '保険', 'extra', 'parking', 'fee', 'cost', 'price', 'total', 'insurance', 'hidden'],
      weak: ['別', '器材', 'included', 'charge', 'pay'],
      para: ['料金のほかにお金はかかりますか', '全部でいくらですか', '追加料金はありますか', '駐車場代はかかりますか', '器材代は料金に入っていますか',
        'are there extra costs', 'how much in total', 'is gear included in the price']
    },
    swim: {
      keys: ['泳げ', 'カナヅチ', '泳ぎ', '初めて', '初心者', 'swim', 'swimmer', 'beginner', 'non swimmer'],
      weak: ['怖', '苦手', '不安', '自信', 'scared', 'afraid', 'nervous'],
      para: ['泳げなくても大丈夫ですか', '泳ぎが苦手です', '初めてでも参加できますか', '水が怖いです',
        "i can't swim well", 'is it ok for beginners', 'i am not a good swimmer']
    },
    time: {
      keys: ['何分', '海に入', '水中', '自由に泳', 'ライフジャケット', '外せ', 'how long', 'minutes', 'life jacket', 'lifejacket', 'in the water'],
      weak: ['時間', 'どのくらい', 'どれくらい', '長さ', 'long'],
      para: ['海に入るのは何分ですか', 'どのくらい海にいられますか', '自由に泳げますか',
        'how long are we in the water', 'how long is the snorkeling']
    },
    turtle: {
      keys: ['ウミガメ', 'カメ', '亀', 'turtle', 'sea turtle'],
      weak: [],
      para: ['ウミガメに会えますか', 'カメは見られますか', '亀に会える確率は', 'will we see turtles', 'are there turtles']
    },
    meet: {
      keys: ['集合', '集ま', '待ち合わせ', '持ち物', '持って', '持参', '水着', 'タオル', '遅刻', '遅れ', '桟橋',
        'meet', 'meeting', 'bring', 'pack', 'late', 'towel', 'swimsuit', 'swimwear', 'pier'],
      weak: ['場所', 'どこ', '何時', 'where', 'what time'],
      para: ['集合場所はどこですか', '何を持っていけばいいですか', '遅れそうなときはどうすればいいですか',
        'where do we meet', 'what do i need to pack']
    },
    seasick: {
      keys: ['船酔い', '酔い', '酔う', '酔い止め', '酔いやすい', '乗り物酔い', 'seasick', 'motion sick', 'sick', 'boat ride'],
      weak: ['船で', '船に乗る', '移動', 'boat'],
      para: ['船酔いが心配です', '酔い止めは飲んだ方がいいですか', 'ポイントまで船でどのくらいですか', 'i get seasick', 'how long is the boat ride']
    },
    crowd: {
      keys: ['混', '空いて', 'すいて', '混雑', '人が多', 'crowd', 'crowded', 'busy', 'quiet', 'quietest'],
      weak: ['時間帯', '朝', '何時', 'time'],
      para: ['混まない時間はいつですか', '空いている時間帯はありますか', '一番すいている便は', 'when is it least crowded', 'when is it not busy']
    },
    kids: {
      keys: ['子ども', '子供', 'こども', 'キッズ', '小学生', '中学生', '幼児', '歳', '英語',
        'kid', 'kids', 'child', 'children', 'son', 'daughter', 'year old', 'years old', 'age', 'english'],
      weak: [],
      para: ['子どもも参加できますか', '何歳から参加できますか', '英語のガイドはいますか', 'can kids join', 'minimum age', 'do you have an english speaking guide']
    },
    flight: {
      keys: ['飛行機', 'フライト', '空港', '帰りの便', '搭乗', 'flight', 'fly', 'flying', 'plane', 'airport'],
      weak: [],
      para: ['潜った後に飛行機に乗れますか', '帰りの飛行機が夕方です', 'can i fly after diving', 'my flight is tomorrow morning']
    }
  };
})();

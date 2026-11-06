// 由 scripts/train.ts 生成，不要手改。改了分词器、模型结构或训练配方后运行 npm run train -w llm-explorer。
import type { WeightsFile } from './weights';

export const WEIGHTS_DATA: WeightsFile = {
 "tokenizer": "96:2341d813",
 "train": {
  "seed": 20240601,
  "steps": 3000,
  "lr": 0.02,
  "logs": [
   {
    "step": 0,
    "loss": 6.472778411720039
   },
   {
    "step": 50,
    "loss": 5.8886583316581556
   },
   {
    "step": 100,
    "loss": 5.467069117968882
   },
   {
    "step": 150,
    "loss": 4.227275951969214
   },
   {
    "step": 200,
    "loss": 3.371502838909618
   },
   {
    "step": 250,
    "loss": 3.185066731755322
   },
   {
    "step": 300,
    "loss": 2.447652173276133
   },
   {
    "step": 350,
    "loss": 2.6329028089240616
   },
   {
    "step": 400,
    "loss": 2.3929401400937134
   },
   {
    "step": 450,
    "loss": 1.9085718801056002
   },
   {
    "step": 500,
    "loss": 2.648195317245017
   },
   {
    "step": 550,
    "loss": 1.1505183398476242
   },
   {
    "step": 600,
    "loss": 1.0029832525495057
   },
   {
    "step": 650,
    "loss": 1.1433910677408679
   },
   {
    "step": 700,
    "loss": 1.6407435950713758
   },
   {
    "step": 750,
    "loss": 1.1451360750599493
   },
   {
    "step": 800,
    "loss": 1.2374687198495429
   },
   {
    "step": 850,
    "loss": 1.357253389663124
   },
   {
    "step": 900,
    "loss": 1.3461636416611982
   },
   {
    "step": 950,
    "loss": 1.4204609955948884
   },
   {
    "step": 1000,
    "loss": 1.6766303539589793
   },
   {
    "step": 1050,
    "loss": 0.8065851532644923
   },
   {
    "step": 1100,
    "loss": 0.8022864729944467
   },
   {
    "step": 1150,
    "loss": 0.8233277368976374
   },
   {
    "step": 1200,
    "loss": 0.6198473205054897
   },
   {
    "step": 1250,
    "loss": 0.8652840317304595
   },
   {
    "step": 1300,
    "loss": 0.9422906799384116
   },
   {
    "step": 1350,
    "loss": 0.8363687534393823
   },
   {
    "step": 1400,
    "loss": 0.5656713529580654
   },
   {
    "step": 1450,
    "loss": 0.9099253070287167
   },
   {
    "step": 1500,
    "loss": 0.6294151624348882
   },
   {
    "step": 1550,
    "loss": 0.3742564359438652
   },
   {
    "step": 1600,
    "loss": 0.42401038227727317
   },
   {
    "step": 1650,
    "loss": 0.357900963551267
   },
   {
    "step": 1700,
    "loss": 1.0636124942458838
   },
   {
    "step": 1750,
    "loss": 0.7223328053884646
   },
   {
    "step": 1800,
    "loss": 0.5338362566427524
   },
   {
    "step": 1850,
    "loss": 0.3822199023837714
   },
   {
    "step": 1900,
    "loss": 0.5446823418651936
   },
   {
    "step": 1950,
    "loss": 0.661641639390439
   },
   {
    "step": 2000,
    "loss": 0.2944546830937327
   },
   {
    "step": 2050,
    "loss": 0.2265507934951313
   },
   {
    "step": 2100,
    "loss": 0.6963505157824696
   },
   {
    "step": 2150,
    "loss": 0.3865054964518976
   },
   {
    "step": 2200,
    "loss": 0.32314395626833636
   },
   {
    "step": 2250,
    "loss": 0.26673174267871447
   },
   {
    "step": 2300,
    "loss": 0.8186058413071869
   },
   {
    "step": 2350,
    "loss": 0.3289282090161951
   },
   {
    "step": 2400,
    "loss": 0.24376115304673285
   },
   {
    "step": 2450,
    "loss": 0.31868877515671123
   },
   {
    "step": 2500,
    "loss": 0.360761342682432
   },
   {
    "step": 2550,
    "loss": 0.24427352553753567
   },
   {
    "step": 2600,
    "loss": 0.2583678554131801
   },
   {
    "step": 2650,
    "loss": 0.19405230439269638
   },
   {
    "step": 2700,
    "loss": 0.25032316429265633
   },
   {
    "step": 2750,
    "loss": 0.21391418815575824
   },
   {
    "step": 2800,
    "loss": 0.42635973153065965
   },
   {
    "step": 2850,
    "loss": 0.48787533497804797
   },
   {
    "step": 2900,
    "loss": 0.37953731478031605
   },
   {
    "step": 2950,
    "loss": 0.38224255790165806
   },
   {
    "step": 2999,
    "loss": 0.40092155328733436
   }
  ]
 },
 "header": {
  "token_embd.weight": {
   "dtype": "F32",
   "shape": [
    353,
    8
   ],
   "data_offsets": [
    0,
    11296
   ]
  },
  "blk.0.attn_norm.weight": {
   "dtype": "F32",
   "shape": [
    8
   ],
   "data_offsets": [
    11296,
    11328
   ]
  },
  "blk.0.attn_q.weight": {
   "dtype": "F32",
   "shape": [
    8,
    8
   ],
   "data_offsets": [
    11328,
    11584
   ]
  },
  "blk.0.attn_k.weight": {
   "dtype": "F32",
   "shape": [
    8,
    8
   ],
   "data_offsets": [
    11584,
    11840
   ]
  },
  "blk.0.attn_v.weight": {
   "dtype": "F32",
   "shape": [
    8,
    8
   ],
   "data_offsets": [
    11840,
    12096
   ]
  },
  "blk.0.attn_output.weight": {
   "dtype": "F32",
   "shape": [
    8,
    8
   ],
   "data_offsets": [
    12096,
    12352
   ]
  },
  "blk.0.ffn_norm.weight": {
   "dtype": "F32",
   "shape": [
    8
   ],
   "data_offsets": [
    12352,
    12384
   ]
  },
  "blk.0.ffn_gate.weight": {
   "dtype": "F32",
   "shape": [
    16,
    8
   ],
   "data_offsets": [
    12384,
    12896
   ]
  },
  "blk.0.ffn_up.weight": {
   "dtype": "F32",
   "shape": [
    16,
    8
   ],
   "data_offsets": [
    12896,
    13408
   ]
  },
  "blk.0.ffn_down.weight": {
   "dtype": "F32",
   "shape": [
    8,
    16
   ],
   "data_offsets": [
    13408,
    13920
   ]
  },
  "blk.1.attn_norm.weight": {
   "dtype": "F32",
   "shape": [
    8
   ],
   "data_offsets": [
    13920,
    13952
   ]
  },
  "blk.1.attn_q.weight": {
   "dtype": "F32",
   "shape": [
    8,
    8
   ],
   "data_offsets": [
    13952,
    14208
   ]
  },
  "blk.1.attn_k.weight": {
   "dtype": "F32",
   "shape": [
    8,
    8
   ],
   "data_offsets": [
    14208,
    14464
   ]
  },
  "blk.1.attn_v.weight": {
   "dtype": "F32",
   "shape": [
    8,
    8
   ],
   "data_offsets": [
    14464,
    14720
   ]
  },
  "blk.1.attn_output.weight": {
   "dtype": "F32",
   "shape": [
    8,
    8
   ],
   "data_offsets": [
    14720,
    14976
   ]
  },
  "blk.1.ffn_norm.weight": {
   "dtype": "F32",
   "shape": [
    8
   ],
   "data_offsets": [
    14976,
    15008
   ]
  },
  "blk.1.ffn_gate.weight": {
   "dtype": "F32",
   "shape": [
    16,
    8
   ],
   "data_offsets": [
    15008,
    15520
   ]
  },
  "blk.1.ffn_up.weight": {
   "dtype": "F32",
   "shape": [
    16,
    8
   ],
   "data_offsets": [
    15520,
    16032
   ]
  },
  "blk.1.ffn_down.weight": {
   "dtype": "F32",
   "shape": [
    8,
    16
   ],
   "data_offsets": [
    16032,
    16544
   ]
  },
  "output_norm.weight": {
   "dtype": "F32",
   "shape": [
    8
   ],
   "data_offsets": [
    16544,
    16576
   ]
  },
  "output.weight": {
   "dtype": "F32",
   "shape": [
    353,
    8
   ],
   "data_offsets": [
    16576,
    27872
   ]
  }
 },
 "data": "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"
};

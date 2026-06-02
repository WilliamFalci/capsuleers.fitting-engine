// AUTO-DERIVED from pyfa-org/Pyfa eos/effects.py: effectID -> stacking
// penaltyGroup. An effect imposes a stacking penalty IFF it appears here
// (its handler passes a non-False stackingPenalties); the group string
// scopes WHICH modifiers penalise each other (same attr + same group).
// Effects NOT listed are applied in full (no stacking penalty) — e.g. a
// cloak's scanResolution multiplier sits in its own group, so it never
// penalises against a Warp Core Stabilizer (default group).
export const STACKING_PENALTY_GROUPS: ReadonlyMap<number, string> = new Map([
    [89,'default'], [91,'default'], [92,'default'], [93,'default'], [95,'default'], [96,'default'], [394,'default'], [395,'default'],
    [494,'default'], [607,'postMul'], [657,'default'], [699,'default'], [763,'default'], [784,'default'], [854,'cloakingScanResolutionMultiplier'], [856,'default'],
    [889,'default'], [891,'default'], [892,'default'], [1024,'default'], [1230,'default'], [1281,'default'], [1318,'default'], [1445,'default'],
    [1446,'default'], [1448,'default'], [1452,'default'], [1472,'default'], [1590,'default'], [1617,'default'], [1720,'default'], [1764,'default'],
    [1885,'postPerc'], [1886,'postPerc'], [2013,'default'], [2014,'default'], [2019,'default'], [2020,'default'], [2041,'default'], [2052,'default'],
    [2152,'default'], [2232,'default'], [2302,'preMul'], [2644,'default'], [2645,'default'], [2646,'default'], [2670,'default'], [2693,'default'],
    [2694,'default'], [2695,'default'], [2696,'default'], [2697,'default'], [2698,'default'], [2716,'default'], [2717,'default'], [2792,'default'],
    [2795,'default'], [2796,'default'], [2797,'default'], [2798,'default'], [2799,'default'], [2801,'default'], [2802,'default'], [2803,'default'],
    [2804,'default'], [2851,'default'], [2858,'default'], [2865,'default'], [2867,'default'], [2868,'default'], [3001,'postPerc'], [3046,'default'],
    [3174,'default'], [3175,'default'], [3182,'default'], [3200,'default'], [3201,'default'], [3586,'default'], [3655,'default'], [3656,'default'],
    [3657,'default'], [3659,'default'], [3674,'default'], [3726,'default'], [3727,'default'], [3993,'postMul'], [3995,'postMul'], [3996,'default'],
    [3997,'default'], [3998,'default'], [3999,'default'], [4002,'postMul'], [4003,'postMul'], [4016,'default'], [4017,'postMul'], [4018,'postMul'],
    [4019,'postMul'], [4020,'postMul'], [4021,'postMul'], [4022,'postMul'], [4023,'postMul'], [4054,'default'], [4055,'default'], [4056,'default'],
    [4057,'postMul'], [4058,'postMul'], [4059,'postMul'], [4060,'postMul'], [4061,'postMul'], [4062,'postMul'], [4063,'postMul'], [4086,'postMul'],
    [4088,'postMul'], [4089,'postMul'], [4135,'default'], [4136,'default'], [4137,'default'], [4138,'default'], [4162,'default'], [4280,'default'],
    [4358,'default'], [4464,'default'], [4489,'default'], [4490,'default'], [4491,'default'], [4492,'default'], [4527,'default'], [4559,'default'],
    [4575,'default'], [4809,'default'], [4810,'default'], [4811,'default'], [4812,'default'], [4906,'postMul'], [4928,'preMul'], [4961,'postMul'],
    [5081,'default'], [5188,'default'], [5189,'default'], [5190,'default'], [5213,'default'], [5214,'default'], [5230,'default'], [5231,'default'],
    [5397,'default'], [5399,'default'], [5440,'postMul'], [5468,'default'], [5560,'default'], [5618,'postPerc'], [5757,'default'], [5867,'default'],
    [5911,'default'], [5912,'postMul'], [5914,'postMul'], [5915,'postMul'], [5916,'postMul'], [5917,'postMul'], [5918,'postMul'], [5919,'postMul'],
    [5920,'postMul'], [5921,'postMul'], [5922,'postMul'], [5923,'postMul'], [5924,'postMul'], [5925,'postMul'], [5926,'postMul'], [5927,'postMul'],
    [5929,'postMul'], [5951,'default'], [5998,'default'], [6010,'postDiv'], [6011,'postDiv'], [6012,'postDiv'], [6014,'postDiv'], [6015,'postDiv'],
    [6016,'postDiv'], [6017,'postDiv'], [6039,'postDiv'], [6040,'postDiv'], [6041,'postDiv'], [6063,'default'], [6076,'postDiv'], [6110,'default'],
    [6111,'default'], [6112,'default'], [6113,'default'], [6135,'default'], [6152,'postDiv'], [6154,'postDiv'], [6164,'default'], [6201,'default'],
    [6208,'default'], [6402,'default'], [6403,'default'], [6404,'default'], [6405,'default'], [6406,'default'], [6409,'default'], [6410,'default'],
    [6411,'default'], [6412,'default'], [6422,'default'], [6423,'default'], [6424,'default'], [6425,'default'], [6426,'default'], [6427,'default'],
    [6428,'default'], [6435,'default'], [6439,'default'], [6440,'default'], [6441,'default'], [6448,'default'], [6449,'default'], [6472,'default'],
    [6473,'default'], [6474,'default'], [6476,'default'], [6478,'default'], [6479,'default'], [6481,'default'], [6484,'postMul'], [6487,'default'],
    [6555,'default'], [6556,'default'], [6557,'default'], [6559,'default'], [6566,'postMul'], [6567,'default'], [6581,'default'], [6582,'postPercent'],
    [6658,'preMul'], [6670,'default'], [6671,'default'], [6682,'default'], [6683,'default'], [6684,'default'], [6686,'default'], [6690,'default'],
    [6692,'default'], [6693,'default'], [6694,'default'], [6727,'default'], [6730,'postMul'], [6731,'postMul'], [6796,'postDiv'], [6797,'postDiv'],
    [6798,'postDiv'], [6799,'postDiv'], [6801,'postDiv'], [6877,'default'], [7029,'default'], [7077,'default'], [7078,'default'], [7098,'default'],
    [7111,'default'], [7142,'default'], [7202,'default'], [7203,'default'], [7223,'default'], [7237,'default'], [8033,'default'], [8057,'default'],
    [8076,'default'], [8082,'default'], [8108,'postMul'], [8109,'postMul'], [8111,'default'], [8112,'default'], [8113,'postMul'], [8114,'postMul'],
    [8119,'default'], [11445,'default'], [11691,'default'], [11946,'default'], [11947,'postMul'], [11948,'postMul'], [11953,'postMul'], [12126,'default'],
    [12597,'default'], [12761,'default'], [12794,'postDiv'], [12795,'postDiv'], [12796,'postDiv'], [12798,'postDiv'], [12799,'postDiv'], [12838,'postMul'],
    [12839,'postMul'],
])

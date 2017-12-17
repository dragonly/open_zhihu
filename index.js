const redis = require('redis')
const bluebird = require('bluebird')
const puppeteer = require('puppeteer')

bluebird.promisifyAll(redis.RedisClient.prototype);
bluebird.promisifyAll(redis.Multi.prototype);

const redisClient = redis.createClient()

redisClient.on("error", function (err) {
  console.log("[Error] " + err)
})

const cookie = 'l_n_c=1; q_c1=707f5ca413944595a58780d4530ad2c6|1513439814000|1513439814000; _xsrf=b896bb9add551e0443d92f09b5d68c2a; cap_id="OWRlYTZjYWUzODNjNDFjMmFiYzNhNDhlNDBlOGUyZmQ=|1513439814|b1a95d1f3965b7d098f9717af7070e16bff66133"; l_cap_id="ZjgwZGQ1YjdlODI3NGE1Y2E1OWU0YzIxNWMwMjQzY2U=|1513439814|bb652abb16a7852cd8eb9b21c4a752ad86745052";_xsrf=b896bb9add551e0443d92f09b5d68c2a; _zap=93b1edab-b843-4645-a3fc-f7a0533b40c7;__utmc=51854390; auth_type=cXFjb25u|1513440017|545a0ac884959630711e503471c94f546c184b84;token="N0ZDMkE3NEJDRTYzMERCNjM0ODhEQjQ4QURDRTBCOTY=|1513440017|8bd355546947838526c8e209871cef6584dea8c9";client_id="MzJGNTc0MzgwMDlCQzVBRjIzQTgyODkxMUYxNDRBOTM=|1513440017|0949c34623bec94fa7662d0162eb86f3c2dd474c";n_c=1; __utmv=51854390.100--|2=registration_date=20171217=1^3=entry_date=20171216=1;__utma=51854390.206809336.1513439838.1513439838.1513446708.2; __utmb=51854390.0.10.1513446708;__utmz=51854390.1513446708.2.2.utmcsr=zhihu.com|utmccn=(referral)|utmcmd=referral|utmcct=/topic'
  .split(';').map(kv => ({name: kv.split('=')[0].trim(), value: kv.split('=')[1].trim()}))

const config = {
  question: {
    idKey: 'zhihu:questionIds',
    todoKey: 'zhihu:questionTodoIds',
    urlTpl: 'https://www.zhihu.com/question/$id',
  },
  topic: {
    idKey: 'zhihu:topicIds',
    todoKey: 'zhihu:topicTodoIds',
    urlTpl: 'https://www.zhihu.com/topic/$id',
  },
  collection: {
    idKey: 'zhihu:collectionIds',
    todoKey: 'zhihu:collectionTodoIds',
    urlTpl: 'https://www.zhihu.com/collection/$id',
  },
  tmp: 'zhihu:tmp',
  throttleTime: {
    min: 100,
    max: 500
  }
}

function randomSleep(min = config.throttleTime.min, max = config.throttleTime.max) {
  let time = min + Math.random() * (max - min)
  console.log(`sleep for ${parseInt(time)} ms`)
  return new Promise((resolve) => {
    setTimeout(function() {resolve()}, time)
  })
}

async function loopFetch(browser, startUrl) {
  // 目前只抓三种链接
  async function getIdsInPage(page) {
    let {questionIds, topicIds, collectionIds} = await page.$$eval(
      'a',
      aList => {
        let questionIds = aList.map(a => a.href.match(/https:\/\/www.zhihu.com\/question\/(\d+)/))
          .filter(match => match !== null).map(match => match[1])
        let topicIds = aList.map(a => a.href.match(/https:\/\/www.zhihu.com\/topic\/(\d+)/))
          .filter(match => match !== null).map(match => match[1])
        let collectionIds = aList.map(a => a.href.match(/https:\/\/www.zhihu.com\/collection\/(\d+)/))
          .filter(match => match !== null).map(match => match[1])
        return {questionIds, topicIds, collectionIds}
      }
    )
    questionIds = Array.from(new Set(questionIds))
    topicIds = Array.from(new Set(topicIds))
    collectionIds = Array.from(new Set(collectionIds))
    return {questionIds, topicIds, collectionIds}
  }
  // 根据todoIds个数的比例来选择下一个类型和id, 从而生成url
  // IMPURE!!!
  async function pickNextUrl() {
    let questionTodoCount = await redisClient.scardAsync(config.question.todoKey)
    let topicTodoCount = await redisClient.scardAsync(config.topic.todoKey)
    let collectionTodoCount = await redisClient.scardAsync(config.collection.todoKey)
    let allCount = questionTodoCount + topicTodoCount + collectionTodoCount
    let toss = Math.random()
    if (toss < questionTodoCount / allCount) {
      let nextId = await redisClient.spopAsync(config.question.todoKey)
      return config.question.urlTpl.replace('$id', nextId)
    }
    if (toss < (questionTodoCount+topicTodoCount) / allCount) {
      let nextId = await redisClient.spopAsync(config.topic.todoKey)
      return config.topic.urlTpl.replace('$id', nextId)
    }
    let nextId = await redisClient.spopAsync(config.collection.todoKey)
    return config.collection.urlTpl.replace('$id', nextId)
  }

  console.log('get initial ids')
  let page = await browser.newPage()
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_13_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/63.0.3239.84 Safari/537.36')
  await page.goto(startUrl, { waitUntil: 'load' })
  await page.setCookie(...cookie)

  let {questionIds, topicIds, collectionIds} = await getIdsInPage(page)
  await redisClient.saddAsync(config.question.idKey, questionIds)
  await redisClient.saddAsync(config.question.todoKey, questionIds)
  await redisClient.saddAsync(config.topic.idKey, topicIds)
  await redisClient.saddAsync(config.topic.todoKey, topicIds)
  await redisClient.saddAsync(config.collection.idKey, collectionIds)
  await redisClient.saddAsync(config.collection.todoKey, collectionIds)

  let url
  let questionIdsUnSeen, topicIdsUnSeen, collectionIdsUnSeen
  let questionCount, topicCount, collectionCount, questionTodoCount, topicTodoCount, collectionTodoCount
  let tmp
  while (true) {
    questionIdsUnSeen = topicIdsUnSeen = collectionIdsUnSeen = []
    url = await pickNextUrl()
    await randomSleep()
    await page.goto(url, { waitUntil: 'load' })
    tmp = await getIdsInPage(page)
    questionIds = tmp.questionIds
    topicIds = tmp.topicIds
    collectionIds = tmp.collectionIds
    if (questionIds.length === 0 && topicIds.length === 0 && collectionIds.length === 0) {
      continue
    }
    if (questionIds.length !== 0) {
      await redisClient.delAsync(config.tmp)
      await redisClient.saddAsync(config.tmp, questionIds)
      questionIdsUnSeen = await redisClient.sdiffAsync(config.tmp, config.question.idKey)
      if (questionIdsUnSeen.length !== 0) {
        await redisClient.saddAsync(config.question.idKey, questionIdsUnSeen)
        await redisClient.saddAsync(config.question.todoKey, questionIdsUnSeen)
      }
    }
    if (topicIds.length !== 0) {
      await redisClient.delAsync(config.tmp)
      await redisClient.saddAsync(config.tmp, topicIds)
      topicIdsUnSeen = await redisClient.sdiffAsync(config.tmp, config.topic.idKey)
      if (topicIdsUnSeen.length !== 0) {
        await redisClient.saddAsync(config.topic.idKey, topicIdsUnSeen)
        await redisClient.saddAsync(config.topic.todoKey, topicIdsUnSeen)
      }
    }
    if (collectionIds.length !== 0) {
      await redisClient.delAsync(config.tmp)
      await redisClient.saddAsync(config.tmp, collectionIds)
      collectionIdsUnSeen = await redisClient.sdiffAsync(config.tmp, config.collection.idKey)
      if (collectionIdsUnSeen.length !== 0) {
        await redisClient.saddAsync(config.collection.idKey, collectionIdsUnSeen)
        await redisClient.saddAsync(config.collection.todoKey, collectionIdsUnSeen)
      }
    }

    questionCount = await redisClient.scardAsync(config.question.idKey)
    questionTodoCount = await redisClient.scardAsync(config.question.todoKey)
    topicCount = await redisClient.scardAsync(config.topic.idKey)
    topicTodoCount = await redisClient.scardAsync(config.topic.todoKey)
    collectionCount = await redisClient.scardAsync(config.collection.idKey)
    collectionTodoCount = await redisClient.scardAsync(config.collection.todoKey)
    console.log(`question:   all ${questionCount}, todo ${questionTodoCount}, new ${questionIdsUnSeen.length}`)
    console.log(`topic:      all ${topicCount}, todo ${topicTodoCount}, new ${topicIdsUnSeen.length}`)
    console.log(`collection: all ${collectionCount}, todo ${collectionTodoCount}, new ${collectionIdsUnSeen.length}`)
  }
}

;(async () => {
  const browser = await puppeteer.launch()
  while (true) {
    try {
      await loopFetch(browser, 'https://www.zhihu.com/explore')
    } catch (e) {
      console.error('error: ', e)
    }
  }
  redisClient.quit()
  console.log('finished')
})().then(() => process.exit(0))
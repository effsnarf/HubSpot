require('./misc/extensions');
const hubspot = require('@hubspot/api-client');
const _ = require('lodash');
const { createQueue, drainQueue } = require('./misc/queue');

const { filterNullValuesFromObject, goal } = require('./misc/utils');
const Domain = require('./misc/Domain');

const hubspotClient = new hubspot.Client({ accessToken: '' });
const propertyPrefix = 'hubspot__';
let expirationDate;


const generateLastModifiedDateFilter = (date, nowDate, propertyName) => {
  if (!propertyName) propertyName = 'hs_lastmodifieddate';
  const lastModifiedDateFilter = date ?
    {
      filters: [
        { propertyName, operator: 'GTE', value: `${date.valueOf()}` },
        { propertyName, operator: 'LTE', value: `${nowDate.valueOf()}` }
      ]
    } :
    {};

  return lastModifiedDateFilter;
};


const saveDomain = async domain => {
  // disable this for testing purposes
  return;

  domain.markModified('integrations.hubspot.accounts');
  await domain.save();
};

/**
 * Get access token from HubSpot
 */
const refreshAccessToken = async (domain, hubId, tryCount) => {
  const { HUBSPOT_CID, HUBSPOT_CS } = process.env;
  const account = domain.integrations.hubspot.accounts.find(account => account.hubId === hubId);
  const { accessToken, refreshToken } = account;

  return hubspotClient.oauth.tokensApi
    .createToken('refresh_token', undefined, undefined, HUBSPOT_CID, HUBSPOT_CS, refreshToken)
    .then(async result => {
      const body = result.body ? result.body : result;

      const newAccessToken = body.accessToken;
      expirationDate = new Date(body.expiresIn * 1000 + new Date().getTime());

      hubspotClient.setAccessToken(newAccessToken);
      if (newAccessToken !== accessToken) {
        account.accessToken = newAccessToken;
      }

      return true;
    });
};



/**
 * Get recently modified entities as 100 entities per page
 */
const processEntities = async (entityName, domain, hubId, q, datePropertyName, sorts, properties, processData) => {
  console.log(`processing ${entityName}...`);

  const account = domain.integrations.hubspot.accounts.find(account => account.hubId === hubId);
  const lastPulledDate = new Date(account.lastPulledDates[entityName]);
  const now = new Date();

  let hasMore = true;
  const offsetObject = {};
  const limit = 100;

  while (hasMore) {
    const lastModifiedDate = offsetObject.lastModifiedDate || lastPulledDate;
    const lastModifiedDateFilter = generateLastModifiedDateFilter(lastModifiedDate, now, datePropertyName);

    let searchObject = {
      filterGroups: [lastModifiedDateFilter],
      sorts,
      properties,
      limit,
      after: offsetObject.after
    };

    let searchResult = {};

    let tryCount = 0;
    while (tryCount <= 4) {
      try {
        const crm = hubspotClient.crm[entityName];
        if (!crm) throw new Error(`Entity [${entityName}] not found in HubSpot CRM`);
        searchResult = await crm.searchApi.doSearch(searchObject);
        break;
      } catch (err) {
        tryCount++;

        console.log(err.body?.message ?? err);

        if (new Date() > expirationDate) await refreshAccessToken(domain, hubId);

        await new Promise((resolve, reject) => setTimeout(resolve, 5000 * Math.pow(2, tryCount)));
      }
    }

    if (!searchResult) throw new Error(`Failed to fetch ${entityName} for the 4th time. Aborting.`);

    const data = searchResult?.results || [];
    offsetObject.after = parseInt(searchResult?.paging?.next?.after);

    console.log(`fetch ${entityName.singularize()} batch`);

    await processData(data, q, lastPulledDate);

    if (!offsetObject?.after) {
      hasMore = false;
      break;
    } else if (offsetObject?.after >= 9900) {
      offsetObject.after = 0;
      offsetObject.lastModifiedDate = new Date(data[data.length - 1].updatedAt).valueOf();
    }
  }
}




const workProcess = {
  companies: async (domain, hubId, q) => {
    await processEntities('companies', domain, hubId, q, null,
      [{ propertyName: 'hs_lastmodifieddate', direction: 'ASCENDING' }],
      [
      'name',
      'domain',
      'country',
      'industry',
      'description',
      'annualrevenue',
      'numberofemployees',
      'hs_lead_status'
      ],
      async (data, q) => {
        data.forEach(company => {
          if (!company.properties) return;
    
          const actionTemplate = {
            includeInAnalytics: 0,
            companyProperties: {
              company_id: company.id,
              company_domain: company.properties.domain,
              company_industry: company.properties.industry
            }
          };
    
          const isCreated = !lastPulledDate || (new Date(company.createdAt) > lastPulledDate);
    
          q.push({
            actionName: isCreated ? 'Company Created' : 'Company Updated',
            actionDate: new Date(isCreated ? company.createdAt : company.updatedAt) - 2000,
            ...actionTemplate
          });
        });
      }
    );
  },
  contacts: async (domain, hubId, q) => {
    await processEntities('contacts', domain, hubId, q, 'lastmodifieddate',
      [{ propertyName: 'lastmodifieddate', direction: 'ASCENDING' }],
      [
      'firstname',
      'lastname',
      'jobtitle',
      'email',
      'hubspotscore',
      'hs_lead_status',
      'hs_analytics_source',
      'hs_latest_source'
    ],
      async (data, q, lastPulledDate) => {
        const contactIds = data.map(contact => contact.id);
  
        // contact to company association
        const contactsToAssociate = contactIds;
        const companyAssociationsResults = (await (await hubspotClient.apiRequest({
          method: 'post',
          path: '/crm/v3/associations/CONTACTS/COMPANIES/batch/read',
          body: { inputs: contactsToAssociate.map(contactId => ({ id: contactId })) }
        })).json())?.results || [];
    
        const companyAssociations = Object.fromEntries(companyAssociationsResults.map(a => {
          if (a.from) {
            contactsToAssociate.splice(contactsToAssociate.indexOf(a.from.id), 1);
            return [a.from.id, a.to[0].id];
          } else return false;
        }).filter(x => x));
  
        data.forEach(contact => {
          if (!contact.properties || !contact.properties.email) return;
  
          const companyId = companyAssociations[contact.id];
    
          const isCreated = new Date(contact.createdAt) > lastPulledDate;
    
          const userProperties = {
            company_id: companyId,
            contact_name: ((contact.properties.firstname || '') + ' ' + (contact.properties.lastname || '')).trim(),
            contact_title: contact.properties.jobtitle,
            contact_source: contact.properties.hs_analytics_source,
            contact_status: contact.properties.hs_lead_status,
            contact_score: parseInt(contact.properties.hubspotscore) || 0
          };
    
          const actionTemplate = {
            includeInAnalytics: 0,
            identity: contact.properties.email,
            userProperties: filterNullValuesFromObject(userProperties)
          };
    
          q.push({
            actionName: isCreated ? 'Contact Created' : 'Contact Updated',
            actionDate: new Date(isCreated ? contact.createdAt : contact.updatedAt),
            ...actionTemplate
          });
        });
      }
    );
  },
  meetings: async (domain, hubId, q) => {
    await processEntities('meetings', domain, hubId, q, null,
      [{ propertyName: 'lastmodifieddate', direction: 'ASCENDING' }],
      [
      'title',
      ],
      async (data, q) => {
        data.forEach(meeting => {
          if (!meeting.properties) return;
    
          const actionTemplate = {
            includeInAnalytics: 0,
            meetingProperties: {
              meeting_id: meeting.id,
              meeting_title: meeting.properties.title,
              meeting_timestamp: meeting.properties.timestamp
            }
          };
    
          const isCreated = !lastPulledDate || (new Date(meeting.createdAt) > lastPulledDate);
    
          q.push({
            actionName: isCreated ? 'Meeting Created' : 'Meeting Updated',
            actionDate: new Date(isCreated ? meeting.createdAt : meeting.updatedAt) - 2000,
            ...actionTemplate
          });
        });
      }
    );
  }
}



const pullDataFromHubspot = async () => {
  console.log('start pulling data from HubSpot');

  const domain = await Domain.findOne({});

  for (const account of domain.integrations.hubspot.accounts) {
    console.log('start processing account');
    
    const tryOperation = async (opName, operation) => {
      try {
        await operation();
      } catch (err) {
        console.log(err, { apiKey: domain.apiKey, metadata: { operation: opName, hubId: account.hubId } });
      }
    }

    const actions = [];
    const q = createQueue(domain, actions);

    await tryOperation('refreshAccessToken', async () => {
      await refreshAccessToken(domain, account.hubId);
    });

    for (const entityName of ['contacts', 'companies', 'meetings']) {
      await tryOperation(`process${entityName.capitalize()}`, async () => {
        await workProcess[entityName](domain, account.hubId, q);
      });
    }

    await tryOperation('drainQueue', async () => {
      await drainQueue(domain, actions, q);
    });

    await saveDomain(domain);

    console.log('finish processing account');
  }

  process.exit();
};



module.exports = pullDataFromHubspot;

/**
 * This file is auto-generated by the Triplit CLI.
 */

import { Schema as S } from '../src/schema/builder.js';
import { Roles } from '../src/index.js';
export const roles: Roles = {
  user: {
    match: {
      companys: '$companys',
      scope: '$scope',
      sub: '$userId',
    },
  },
};
export const schema = S.Collections({
  activity_log: {
    schema: S.Schema({
      animal_id: S.String(),
      company_id: S.String(),
      created_at: S.Date({ default: S.Default.now() }),
      event_type: S.String(),
      id: S.String({ nullable: false, default: S.Default.uuid() }),
      new_values_json: S.String(),
      updated_columns: S.Set(S.String()),

      user_id: S.String(),
    }),
    relationships: {
      user: S.RelationOne('users', {
        where: [['id', '=', '$user_id']],
        limit: 1,
      }),
    },
    permissions: {
      user: {
        delete: {
          filter: [false],
        },
        insert: {
          filter: [['company_id', 'in', '$session._scope']],
        },
        postUpdate: {
          filter: [['company_id', 'in', '$session._scope']],
        },
        read: {
          filter: [['company_id', 'in', '$session._scope']],
        },
        update: {
          filter: [['company_id', 'in', '$session._scope']],
        },
      },
    },
  },
  animals: {
    schema: S.Schema({
      birth_date: S.Date(),
      breed: S.String(),
      breeding_parent_id: S.String({ nullable: true }),
      company_id: S.String(),
      created_at: S.Date({ default: S.Default.now() }),
      eid: S.Optional(S.String()),
      gender: S.String({ default: 'Female' }),
      id: S.String({ nullable: false, default: S.Default.uuid() }),
      identifier: S.String(),
      milking: S.Boolean({ default: false }),
      mother_id: S.String({ nullable: true }),
      property_id: S.String(),
      unvailable_cause: S.Optional(S.String()),
      unvailable_date: S.Optional(S.Date()),
      weight: S.Number(),
    }),
    relationships: {
      all_breedings: S.RelationMany('breeding', {
        where: [['animal_id', '=', '$id']],
      }),
      all_logs: S.RelationMany('activity_log', {
        where: [['animal_id', '=', '$id']],
      }),
      breeding_children: S.RelationMany('breeding', {
        where: [
          ['animal_id', '=', '$id'],
          ['stage', '!=', 'Failed'],
          ['stage', '!=', 'Miscarried'],
          ['stage', '!=', 'Birthed'],
        ],
      }),
      children: S.RelationMany('animals', {
        where: [['mother_id', '=', '$id']],
      }),
      comments: S.RelationMany('chat', { where: [['animal_id', '=', '$id']] }),
      milking_changes: S.RelationMany('activity_log', {
        where: [
          ['animal_id', '=', '$id'],
          ['updated_columns', 'has', 'milking'],
        ],
        order: [['created_at', 'DESC']],
      }),
      mother: S.RelationOne('animals', {
        where: [['id', '=', '$mother_id']],
        limit: 1,
      }),
      property: S.RelationOne('propertys', {
        where: [['id', '=', '$property_id']],
        limit: 1,
      }),
      treatment_courses: S.RelationMany('treatment_course', {
        where: [['animal_id', '=', '$id']],
      }),
      treatments: S.RelationMany('treatment', {
        where: [['animal_id', '=', '$id']],
      }),
    },
    permissions: {
      user: {
        delete: {
          filter: [false],
        },
        insert: {
          filter: [['company_id', 'in', '$session._scope']],
        },
        postUpdate: {
          filter: [['company_id', 'in', '$session._scope']],
        },
        read: {
          filter: [['company_id', 'in', '$session._scope']],
        },
        update: {
          filter: [['company_id', 'in', '$session._scope']],
        },
      },
    },
  },
  breeding: {
    schema: S.Schema({
      animal_id: S.String(),
      check_ins: S.Set(S.Date()),
      company_id: S.String(),
      completion_date: S.Optional(S.Date()),
      id: S.String({ nullable: false, default: S.Default.uuid() }),
      joining_date: S.Date(),
      stage: S.String(),
    }),
    relationships: {
      child: S.RelationOne('animals', {
        where: [['breeding_parent_id', '=', '$id']],
        limit: 1,
      }),
      mother: S.RelationOne('animals', {
        where: [['id', '=', '$animal_id']],
        limit: 1,
      }),
    },
    permissions: {
      user: {
        delete: {
          filter: [false],
        },
        insert: {
          filter: [['company_id', 'in', '$session._scope']],
        },
        postUpdate: {
          filter: [['company_id', 'in', '$session._scope']],
        },
        read: {
          filter: [['company_id', 'in', '$session._scope']],
        },
        update: {
          filter: [['company_id', 'in', '$session._scope']],
        },
      },
    },
  },
  chat: {
    schema: S.Schema({
      animal_id: S.Optional(S.String()),
      company_id: S.String(),
      created_at: S.Date({ default: S.Default.now() }),
      id: S.String({ nullable: false, default: S.Default.uuid() }),
      message: S.String(),
      seen_by: S.Set(S.String()),
      user_id: S.String(),
    }),
    relationships: {
      animal: S.RelationOne('animals', {
        where: [['id', '=', '$animal_id']],
        limit: 1,
      }),
      user: S.RelationOne('users', {
        where: [['id', '=', '$user_id']],
        limit: 1,
      }),
    },
    permissions: {
      user: {
        delete: {
          filter: [false],
        },
        insert: {
          filter: [['company_id', 'in', '$session._scope']],
        },
        postUpdate: {
          filter: [['company_id', 'in', '$session._scope']],
        },
        read: {
          filter: [['company_id', 'in', '$session._scope']],
        },
        update: {
          filter: [['company_id', 'in', '$session._scope']],
        },
      },
    },
  },
  companys: {
    schema: S.Schema({
      id: S.String({ nullable: false, default: S.Default.uuid() }),
      name: S.String(),
      owner_id: S.String(),
      users: S.Set(S.String()),
    }),
    relationships: {
      properties: S.RelationMany('propertys', {
        where: [['company_id', '=', '$id']],
      }),
      userObjects: S.RelationMany('users', { where: [['id', 'in', '$users']] }),
    },
    permissions: {
      user: {
        delete: {
          filter: [false],
        },
        insert: {
          filter: [false],
        },
        postUpdate: {
          filter: [['owner_id', '=', '$role.userId']],
        },
        read: {
          filter: [['id', 'in', '$session._scope']],
        },
        update: {
          filter: [['owner_id', '=', '$role.userId']],
        },
      },
    },
  },
  milk_log: {
    schema: S.Schema({
      auto: S.Boolean({ default: false }),
      company_id: S.String(),
      id: S.String({ nullable: false, default: S.Default.uuid() }),
      picked_at: S.Date(),
      property_id: S.String(),
      temperature: S.Number(),
      volume: S.Number(),
    }),
    permissions: {
      user: {
        insert: {
          filter: [['company_id', 'in', '$session._scope']],
        },
        postUpdate: {
          filter: [['company_id', 'in', '$session._scope']],
        },
        read: {
          filter: [['company_id', 'in', '$session._scope']],
        },
        update: {
          filter: [['company_id', 'in', '$session._scope']],
        },
      },
    },
  },
  propertys: {
    schema: S.Schema({
      api_keys: S.Optional(S.Set(S.String())),
      company_id: S.String(),
      email_id: S.Optional(S.String()),
      id: S.String({ nullable: false, default: S.Default.uuid() }),
      name: S.String(),
    }),
    relationships: {
      animals: S.RelationMany('animals', {
        where: [['property_id', '=', '$id']],
      }),
      milking_logs: S.RelationMany('milk_log', {
        where: [['property_id', '=', '$id']],
      }),
      smart_sensors: S.RelationMany('smart_sensor', {
        where: [['property_id', '=', '$id']],
      }),
      tasks: S.RelationMany('tasks', { where: [['property_id', '=', '$id']] }),
    },
    permissions: {
      user: {
        delete: {
          filter: [false],
        },
        insert: {
          filter: [['company_id', 'in', '$session._scope']],
        },
        postUpdate: {
          filter: [['company_id', 'in', '$session._scope']],
        },
        read: {
          filter: [['company_id', 'in', '$session._scope']],
        },
        update: {
          filter: [['company_id', 'in', '$session._scope']],
        },
      },
    },
  },
  scanning_sessions: {
    schema: S.Schema({
      company_id: S.String(),
      created_at: S.Date({ default: S.Default.now() }),
      finished: S.Boolean({ default: false }),
      group_options: S.Number(),
      id: S.String({ nullable: false, default: S.Default.uuid() }),
      name: S.String(),
      property_id: S.String(),
    }),
    relationships: {
      scans: S.RelationMany('session_scans', {
        where: [['session_id', '=', '$id']],
        order: [['group', 'ASC']],
      }),
    },
    permissions: {
      user: {
        delete: {
          filter: [false],
        },
        insert: {
          filter: [['company_id', 'in', '$session._scope']],
        },
        postUpdate: {
          filter: [['company_id', 'in', '$session._scope']],
        },
        read: {
          filter: [['company_id', 'in', '$session._scope']],
        },
        update: {
          filter: [['company_id', 'in', '$session._scope']],
        },
      },
    },
  },
  session_scans: {
    schema: S.Schema({
      animal_id: S.String(),
      company_id: S.String(),
      created_at: S.Date({ default: S.Default.now() }),
      group: S.Optional(S.String()),
      id: S.String({ nullable: false, default: S.Default.uuid() }),
      session_id: S.String(),
    }),
    permissions: {
      user: {
        delete: {
          filter: [['company_id', 'in', '$session._scope']],
        },
        insert: {
          filter: [['company_id', 'in', '$session._scope']],
        },
        postUpdate: {
          filter: [['company_id', 'in', '$session._scope']],
        },
        read: {
          filter: [['company_id', 'in', '$session._scope']],
        },
        update: {
          filter: [['company_id', 'in', '$session._scope']],
        },
      },
    },
  },
  smart_sensor: {
    schema: S.Schema({
      company_id: S.String(),
      created_at: S.Date({ default: S.Default.now() }),
      id: S.String({ nullable: false, default: S.Default.uuid() }),
      last_updated: S.Date(),
      property_id: S.String(),
      sensor_name: S.String(),
      sensor_type: S.String(),
      value: S.Number(),
    }),
    permissions: {
      user: {
        read: {
          filter: [['company_id', 'in', '$session._scope']],
        },
      },
    },
  },
  tasks: {
    schema: S.Schema({
      assignee_id: S.Optional(S.String()),
      company_id: S.String(),
      completed: S.Boolean({ default: false }),
      completed_at: S.Optional(S.Date()),
      created_at: S.Date({ default: S.Default.now() }),
      created_by_id: S.String(),
      description: S.String(),
      due_date: S.Optional(S.Date()),
      id: S.String({ nullable: false, default: S.Default.uuid() }),
      property_id: S.String(),
      title: S.String(),
    }),
    relationships: {
      assignee: S.RelationOne('users', {
        where: [['id', '=', '$assignee_id']],
        limit: 1,
      }),
      created_by: S.RelationOne('users', {
        where: [['id', '=', '$created_by_id']],
        limit: 1,
      }),
    },
    permissions: {
      user: {
        delete: {
          filter: [false],
        },
        insert: {
          filter: [['company_id', 'in', '$session._scope']],
        },
        postUpdate: {
          filter: [['company_id', 'in', '$session._scope']],
        },
        read: {
          filter: [['company_id', 'in', '$session._scope']],
        },
        update: {
          filter: [['company_id', 'in', '$session._scope']],
        },
      },
    },
  },
  treatment: {
    schema: S.Schema({
      administered_at: S.Optional(S.Date()),
      animal_id: S.String(),
      company_id: S.String(),
      course_id: S.String(),
      id: S.String({ nullable: false, default: S.Default.uuid() }),
      index: S.Number(),
      scheduled_date: S.Date(),
      user_id: S.Optional(S.String()),
    }),
    relationships: {
      user: S.RelationOne('users', {
        where: [['id', '=', '$user_id']],
        limit: 1,
      }),
    },
    permissions: {
      user: {
        delete: {
          filter: [false],
        },
        insert: {
          filter: [['company_id', 'in', '$session._scope']],
        },
        postUpdate: {
          filter: [['company_id', 'in', '$session._scope']],
        },
        read: {
          filter: [['company_id', 'in', '$session._scope']],
        },
        update: {
          filter: [['company_id', 'in', '$session._scope']],
        },
      },
    },
  },
  treatment_course: {
    schema: S.Schema({
      amount: S.Number(),
      animal_id: S.String(),
      company_id: S.String(),
      details_id: S.String(),
      id: S.String({ nullable: false, default: S.Default.uuid() }),
      length: S.Number(),
      scheduled_date: S.Date({ nullable: true }),
      user_id: S.String(),
    }),
    relationships: {
      animal: S.RelationOne('animals', {
        where: [['id', '=', '$animal_id']],
        limit: 1,
      }),
      details: S.RelationOne('treatment_details', {
        where: [['id', '=', '$details_id']],
        limit: 1,
      }),
      treatments: S.RelationMany('treatment', {
        where: [['course_id', '=', '$id']],
        order: [['scheduled_date', 'ASC']],
      }),
      user: S.RelationOne('users', {
        where: [['id', '=', '$user_id']],
        limit: 1,
      }),
    },
    permissions: {
      user: {
        delete: {
          filter: [false],
        },
        insert: {
          filter: [['company_id', 'in', '$session._scope']],
        },
        postUpdate: {
          filter: [['company_id', 'in', '$session._scope']],
        },
        read: {
          filter: [['company_id', 'in', '$session._scope']],
        },
        update: {
          filter: [['company_id', 'in', '$session._scope']],
        },
      },
    },
  },
  treatment_details: {
    schema: S.Schema({
      for: S.Set(S.String()),
      id: S.String({ nullable: false, default: S.Default.uuid() }),
      name: S.String(),
      standard_length: S.Number(),
      standard_per_kilo: S.Number(),
      type: S.String(),
    }),
  },
  users: {
    schema: S.Schema({
      email: S.String(),
      id: S.String({ nullable: false, default: S.Default.uuid() }),
      name: S.String(),
      phone: S.Optional(S.String()),
    }),
    relationships: {
      companys: S.RelationMany('companys', { where: [['users', 'in', '$id']] }),
    },
    permissions: {
      user: {
        delete: {
          filter: [false],
        },
        insert: {
          filter: [false],
        },
        postUpdate: {
          filter: [['id', '=', '$role.userId']],
        },
        read: {
          filter: [true],
        },
        update: {
          filter: [['id', '=', '$role.userId']],
        },
      },
    },
  },
  vat_log: {
    schema: S.Schema({
      company_id: S.String(),
      created_at: S.Date(),
      id: S.String({ nullable: false, default: S.Default.uuid() }),
      property_id: S.String(),
      temperature: S.Optional(S.Number()),
      volume: S.Optional(S.Number()),
    }),
    permissions: {
      user: {
        insert: {
          filter: [['company_id', 'in', '$session._scope']],
        },
        postUpdate: {
          filter: [['company_id', 'in', '$session._scope']],
        },
        read: {
          filter: [['company_id', 'in', '$session._scope']],
        },
        update: {
          filter: [['company_id', 'in', '$session._scope']],
        },
      },
    },
  },
  views: {
    schema: S.Schema({
      company_id: S.String(),
      created_at: S.Date({ default: S.Default.now() }),
      creator_id: S.String(),
      grouping: S.String(),
      id: S.String({ nullable: false, default: S.Default.uuid() }),
      name: S.String(),
      ordering: S.String(),
      property_id: S.String(),
      public: S.Boolean({ default: false }),
      query_data: S.String(),
    }),
    permissions: {
      user: {
        delete: {
          filter: [false],
        },
        insert: {
          filter: [['company_id', 'in', '$session._scope']],
        },
        postUpdate: {
          filter: [['company_id', 'in', '$session._scope']],
        },
        read: {
          filter: [['company_id', 'in', '$session._scope']],
        },
        update: {
          filter: [['creator_id', '=', '$userId']],
        },
      },
    },
  },
});

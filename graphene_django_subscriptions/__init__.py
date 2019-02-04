# -*- coding: utf-8 -*-
from graphene import get_version

from .consumers import GraphqlAPIDemultiplexer
from .subscription import Subscription
from .middleware import depromise_subscription

__author__ = 'Ernesto'

VERSION = (0, 0, 6, 'final', '')

__version__ = get_version(VERSION)

__all__ = (
    '__version__',

    'Subscription',
    'GraphqlAPIDemultiplexer',
    'depromise_subscription'
)
